import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Board, Task } from './board.ts';
import { channelForTask, postMessage } from './chat.ts';
import type { WorkspaceRemoteConfig } from './config.ts';
import { checkedOutBranch, workspacePath } from './worktree.ts';

/*
 * Every workspace is its own git repository with a private GitHub remote (origin), and its work is
 * always pushed there so a lost server disk does not lose the code (owner's rule, T0138).
 * - A workspace the engine creates is initialised as a repo (branch main, first commit).
 * - A workspace repo without origin gets a private GitHub repo made with gh and its branch pushed.
 * - After `bf task done` merges into the base branch, that branch is pushed.
 * Pushes only go to remotes gh confirms are PRIVATE, so nothing is published by accident.
 * Failures never block the work: callers log them and warn in the project channel.
 */

export interface RemoteResult {
  ok: boolean;
  /** What happened (repo URL, pushed branch) or why it failed. */
  message: string;
  /** Not a failure but a rule: origin is not private, so it is never pushed to automatically. */
  skipped?: boolean;
}

const TIMEOUT_MS = 120_000;
// Never wait for a password prompt inside the engine.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };

function run(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, env: ENV });
  const err = r.error ? r.error.message : (r.stderr ?? '').trim();
  return { ok: r.status === 0 && !r.error, out: (r.stdout ?? '').trim(), err };
}

const git = (dir: string, ...args: string[]) => run('git', ['-C', dir, ...args]);

function gh(cfg: WorkspaceRemoteConfig, args: string[], cwd?: string) {
  const [cmd, ...lead] = cfg.gh_command;
  return run(cmd, [...lead, ...args], cwd);
}

export function isRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

export function originUrl(dir: string): string | null {
  if (!isRepo(dir)) return null;
  const r = git(dir, 'remote', 'get-url', 'origin');
  return r.ok && r.out ? r.out : null;
}

/**
 * A new workspace folder becomes a git repo on main with a first commit (README + .gitignore that
 * keeps .env and node_modules out), so it can get worktrees and a remote right away.
 * Does nothing when the folder is already a repo.
 */
export function initWorkspaceRepo(dir: string, name: string): RemoteResult {
  if (isRepo(dir)) return { ok: true, message: '이미 git 저장소' };
  fs.mkdirSync(dir, { recursive: true });
  const i = git(dir, 'init', '-q', '-b', 'main');
  if (!i.ok) return { ok: false, message: `git init 실패: ${i.err}` };
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, `# ${name}\n`);
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '.env\n.env.*\nnode_modules/\n');
  git(dir, 'add', '-A');
  const c = git(dir, '-c', 'user.name=BusinessFactory', '-c', 'user.email=bf@localhost', 'commit', '-q', '-m', `chore: ${name} 작업 공간 초기화`);
  return c.ok ? { ok: true, message: 'git 저장소 초기화 (main)' } : { ok: false, message: `첫 커밋 실패: ${c.err}` };
}

/** Whether the repo has a checked-out branch with at least one commit (something to push). */
export function hasCommits(dir: string): boolean {
  return isRepo(dir) && git(dir, 'rev-parse', '-q', '--verify', 'HEAD').ok && git(dir, 'symbolic-ref', '-q', 'HEAD').ok;
}

/**
 * Makes a PRIVATE GitHub repo (<owner>/<name>, or the gh account's when owner is null) for a
 * workspace repo without origin, connects it as origin and pushes the checked-out branch.
 * Null when there is nothing to do (no repo, no commit yet, origin already set).
 */
export function createPrivateRemote(dir: string, name: string, cfg: WorkspaceRemoteConfig): RemoteResult | null {
  if (!hasCommits(dir) || originUrl(dir)) return null;
  const repo = cfg.owner ? `${cfg.owner}/${name}` : name;
  const r = gh(cfg, ['repo', 'create', repo, '--private', '--source', dir, '--remote', 'origin', '--push'], dir);
  if (!r.ok) return { ok: false, message: `GitHub 비공개 저장소 ${repo} 생성 실패: ${r.err || r.out}` };
  return { ok: true, message: `GitHub 비공개 저장소 ${originUrl(dir) ?? repo} 생성·연결, 첫 push 완료` };
}

/**
 * Pushes the branch to origin, but only after gh confirms origin is a PRIVATE repository.
 * Null when there is no origin (nothing to push to).
 */
export function pushToOrigin(dir: string, branch: string, cfg: WorkspaceRemoteConfig): RemoteResult | null {
  const url = originUrl(dir);
  if (!url) return null;
  const v = gh(cfg, ['repo', 'view', url, '--json', 'visibility', '-q', '.visibility'], dir);
  if (!v.ok) return { ok: false, message: `origin(${url}) 공개 범위를 확인하지 못해 push 하지 않았습니다: ${v.err || v.out}` };
  if (v.out.toUpperCase() !== 'PRIVATE') {
    return { ok: false, skipped: true, message: `origin(${url}) 이 비공개 저장소가 아니라(${v.out || '알 수 없음'}) 자동 push 하지 않았습니다.` };
  }
  const p = git(dir, 'push', '-q', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  return p.ok ? { ok: true, message: `origin ${branch} push 완료` } : { ok: false, message: `origin ${branch} push 실패: ${p.err}` };
}

/**
 * After a task on a workspace reports done (`bf task done`): push the branch its work landed on
 * (the worktree's base branch, else the checked-out branch) to the private origin. A failure never
 * fails the report: it is noted in the task's log and warned about in the project channel.
 * Returns the line to show the employee, or null when there was nothing to push.
 */
export function pushAfterDone(board: Board, task: Task): string | null {
  const cfg = board.config.workspace_remote;
  if (!cfg?.enabled || !task.workspace) return null;
  const dir = workspacePath(board.paths, task.workspace);
  const branch = task.worktree && !task.worktree.removed ? task.worktree.base : checkedOutBranch(dir);
  if (!branch) return null;
  let r: RemoteResult | null;
  try {
    r = pushToOrigin(dir, branch, cfg);
  } catch (e) {
    r = { ok: false, message: `push 오류: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!r) return null;
  if (r.ok || r.skipped) return r.message;
  try {
    board.comment('engine', task.id, `⚠️ 원격 push 경고: ${r.message}`);
  } catch {
    // best-effort
  }
  try {
    const conv = channelForTask(board.paths, task);
    postMessage(board.paths, conv.id, 'ceo', `⚠️ ${task.id} 작업 공간 ${task.workspace} 원격 push 실패 — ${r.message}`, { chain: 99, kind: 'system' });
  } catch {
    // best-effort
  }
  return `⚠️ ${r.message} (완료 보고에는 영향 없음)`;
}
