import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './board.ts';
import type { Task, TaskWorktree } from './board.ts';
import { withLock } from './fsutil.ts';
import type { Paths } from './paths.ts';

/*
 * Each task on a git workspace works in its own worktree (branch bf/<id>, forked from the branch
 * the workspace has checked out), so several tasks can change one workspace at the same time.
 * `bf task done` folds the base branch in (the employee resolves conflicts in that same run) and
 * fast-forwards the base branch; the engine removes the worktree once the task has ended.
 */

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

export function workspacePath(paths: Paths, name: string): string {
  return path.join(paths.workspaces, name);
}

/** The branch the workspace has checked out; null if it is not a git repo or HEAD is detached. */
export function checkedOutBranch(dir: string): string | null {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const r = git(dir, 'symbolic-ref', '--short', '-q', 'HEAD');
  return r.ok && r.out ? r.out : null;
}

/** Whether tasks on this workspace get their own worktree. */
export function usesWorktrees(paths: Paths, workspace: string | null): boolean {
  return workspace !== null && checkedOutBranch(workspacePath(paths, workspace)) !== null;
}

function lockFor(paths: Paths, workspace: string): string {
  return path.join(paths.workspaces, '.worktrees', `${workspace}.lock`);
}

/** Creates the task's worktree, or returns the existing one. Null when the workspace is not a git repo. */
export function ensureWorktree(paths: Paths, task: Task): TaskWorktree | null {
  if (!task.workspace) return null;
  if (task.worktree && fs.existsSync(task.worktree.path)) return task.worktree;
  const main = workspacePath(paths, task.workspace);
  const base = task.worktree?.base ?? checkedOutBranch(main);
  if (!base) return null;
  const branch = task.worktree?.branch ?? `bf/${task.id}`;
  const wt = path.join(paths.workspaces, '.worktrees', task.workspace, task.id);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  return withLock(lockFor(paths, task.workspace), () => {
    git(main, 'worktree', 'prune');
    const exists = git(main, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).ok;
    const r = exists ? git(main, 'worktree', 'add', wt, branch) : git(main, 'worktree', 'add', '-b', branch, wt, base);
    if (!r.ok) throw new Error(`${task.id} worktree 를 만들지 못했습니다: ${r.err}`);
    shareIgnored(main, wt);
    return { path: wt, branch, base };
  });
}

/**
 * Files git ignores (node_modules, .env, build outputs) are not in a fresh worktree; link them from
 * the main checkout so installs, secrets and builds work the same. The links are excluded from git
 * so nobody commits them.
 */
function shareIgnored(main: string, wt: string): void {
  const r = git(main, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory');
  if (!r.ok) return;
  const entries = r.out.split('\n').map((s) => s.replace(/\/$/, '')).filter((s) => s && !s.startsWith('.git')).slice(0, 200);
  const common = git(main, 'rev-parse', '--git-common-dir').out;
  const excludeFile = path.resolve(main, common, 'info', 'exclude');
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8').split('\n') : [];
  const add: string[] = [];
  for (const rel of entries) {
    const source = path.join(main, rel);
    const target = path.join(wt, rel);
    if (fs.existsSync(target) || !fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.symlinkSync(source, target, fs.statSync(source).isDirectory() ? 'junction' : 'file');
    } catch {
      continue; // a missing link only costs a reinstall or rebuild
    }
    // Without the trailing slash, so the pattern also matches the link (a link is not a directory to git).
    const line = `/${rel.split(path.sep).join('/')}`;
    if (!existing.includes(line)) add.push(line);
  }
  if (add.length) {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `${existing.at(-1) === '' || existing.length === 0 ? '' : '\n'}# BusinessFactory worktree links\n${add.join('\n')}\n`);
  }
}

/**
 * At `bf task done`: commit what is left, fold the base branch in, then move the base branch up to
 * the task's work. Throws (with what to do) on a conflict, so the employee fixes it in the same run.
 */
export function integrateWorktree(paths: Paths, task: Task): string | null {
  const w = task.worktree;
  if (!w || !task.workspace || !fs.existsSync(w.path)) return null;
  const main = workspacePath(paths, task.workspace);
  return withLock(lockFor(paths, task.workspace), () => {
    if (git(w.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').ok) {
      throw new BoardError(`${w.path} 에서 병합이 끝나지 않았습니다. 충돌을 해결하고 git add, git commit 한 뒤 다시 완료 보고하세요.`);
    }
    const who = ['-c', `user.name=${task.assignee}`, '-c', 'user.email=bf@localhost'];
    git(w.path, 'add', '-A');
    if (!git(w.path, 'diff', '--cached', '--quiet').ok) {
      const c = git(w.path, ...who, 'commit', '-q', '-m', `${task.id}: ${task.title}`);
      if (!c.ok) throw new BoardError(`작업 내용을 커밋하지 못했습니다: ${c.err}`);
    }
    const m = git(w.path, ...who, 'merge', '--no-edit', w.base);
    if (!m.ok) {
      const conflicts = git(w.path, 'diff', '--name-only', '--diff-filter=U').out;
      if (conflicts) {
        throw new BoardError(
          `기준 브랜치 ${w.base} 에 다른 업무의 변경이 먼저 들어와 충돌했습니다: ${conflicts.split('\n').join(', ')}\n` +
            `${w.path} 에서 충돌을 해결하고 git add, git commit 한 뒤 다시 완료 보고하세요. (되돌리려면 git merge --abort)`,
        );
      }
      throw new BoardError(`기준 브랜치 ${w.base} 를 합치지 못했습니다: ${m.err}`);
    }
    const head = git(w.path, 'rev-parse', 'HEAD').out;
    if (checkedOutBranch(main) === w.base) {
      const f = git(main, 'merge', '--ff-only', '-q', w.branch);
      if (!f.ok) {
        throw new BoardError(
          `작업 공간 ${main} 의 ${w.base} 에 반영하지 못했습니다: ${f.err}\n작업 공간에 커밋되지 않은 변경이 겹치면 생깁니다. 사용자에게 알리세요(bf task ask).`,
        );
      }
    } else {
      const old = git(main, 'rev-parse', `refs/heads/${w.base}`).out;
      if (!git(main, 'merge-base', '--is-ancestor', old, head).ok || !git(main, 'update-ref', `refs/heads/${w.base}`, head, old).ok) {
        throw new BoardError(`${w.base} 브랜치를 갱신하지 못했습니다. 다시 완료 보고해 보세요.`);
      }
    }
    return `${w.branch} → ${w.base} 반영 (${head.slice(0, 7)})`;
  });
}

/** After the task ended: drop its worktree, and its branch too when the work reached the base branch. */
export function removeWorktree(paths: Paths, task: Task): void {
  const w = task.worktree;
  if (!w || !task.workspace) return;
  const main = workspacePath(paths, task.workspace);
  withLock(lockFor(paths, task.workspace), () => {
    if (fs.existsSync(w.path)) git(main, 'worktree', 'remove', '--force', w.path);
    git(main, 'worktree', 'prune');
    // -d refuses unmerged branches, so failed or cancelled work is kept for later.
    if (task.status === 'done') git(main, 'branch', '-d', '-q', w.branch);
  });
}
