import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Board } from '../src/board.ts';
import { ensureChannel, ensureProjectChannel, projectDescription, readMessages } from '../src/chat.ts';
import { main } from '../src/cli.ts';
import { DEFAULT_CONFIG, DEFAULT_WORKSPACE_REMOTE, loadConfig } from '../src/config.ts';
import type { Config, WorkspaceRemoteConfig } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { createMission } from '../src/missions.ts';
import { resolvePaths } from '../src/paths.ts';
import { createPrivateRemote, initWorkspaceRepo, originUrl, pushToOrigin } from '../src/remote.ts';
import { runAgent } from '../src/runner.ts';
import { ensureWorktree } from '../src/worktree.ts';
import { makeBoard, makeRoot } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.ts', import.meta.url));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/**
 * A stand-in for the GitHub CLI: `repo create` makes a bare repo under <dir>/hub and pushes to it,
 * `repo view <url> --json visibility` answers from <url>.vis. Every call is logged to <dir>/gh.log.
 * Never touches GitHub.
 */
function fakeGh(dir: string): WorkspaceRemoteConfig {
  const hub = path.join(dir, 'hub');
  fs.mkdirSync(hub, { recursive: true });
  const script = path.join(dir, 'fake-gh.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const hub = ${JSON.stringify(hub)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, 'gh.log'))}, JSON.stringify(args) + '\\n');
const opt = (k) => args[args.indexOf(k) + 1];
const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
if (args[0] === 'repo' && args[1] === 'create') {
  const name = args[2].split('/').pop();
  const bare = path.join(hub, name + '.git');
  if (fs.existsSync(bare)) { console.error('already exists'); process.exit(1); }
  git('init', '-q', '--bare', bare);
  fs.writeFileSync(bare + '.vis', args.includes('--private') ? 'PRIVATE' : 'PUBLIC');
  const src = opt('--source');
  git('-C', src, 'remote', 'add', opt('--remote'), bare);
  if (args.includes('--push')) { const p = git('-C', src, 'push', '-q', '-u', opt('--remote'), 'HEAD'); if (p.status) { console.error(p.stderr); process.exit(1); } }
  console.log('https://github.com/x/' + name);
} else if (args[0] === 'repo' && args[1] === 'view') {
  const vis = args[2] + '.vis';
  if (!fs.existsSync(vis)) { console.error('Could not resolve to a Repository'); process.exit(1); }
  console.log(fs.readFileSync(vis, 'utf8'));
} else { process.exit(2); }
`,
  );
  return { enabled: true, owner: 'acme', gh_command: [process.execPath, script] };
}

const ghCalls = (dir: string): string[][] =>
  fs.existsSync(path.join(dir, 'gh.log')) ? fs.readFileSync(path.join(dir, 'gh.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

/** A workspace repo on main with one commit and no remote. */
function repo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# app — 테스트 앱\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('작업 공간 원격 저장소', () => {
  it('기본값은 꺼져 있고, 옛 config.yaml(항목 없음)도 그대로 읽힌다', () => {
    const { board } = makeBoard();
    fs.writeFileSync(board.paths.config, 'owner: owner\nautonomy: true\n');
    const c = loadConfig(board.paths);
    assert.deepEqual(c.workspace_remote, DEFAULT_WORKSPACE_REMOTE);
    assert.equal(c.workspace_remote.enabled, false);
    fs.writeFileSync(board.paths.config, 'workspace_remote:\n  enabled: true\n');
    assert.deepEqual(loadConfig(board.paths).workspace_remote, { ...DEFAULT_WORKSPACE_REMOTE, enabled: true });
  });

  it('origin 없는 작업 공간 저장소에 비공개 GitHub 저장소를 만들어 연결하고 첫 push 한다', () => {
    const root = makeRoot();
    const cfg = fakeGh(root);
    const dir = repo(path.join(root, 'workspaces', 'app'));
    const r = createPrivateRemote(dir, 'app', cfg)!;
    assert.ok(r.ok, r.message);
    const create = ghCalls(root).find((a) => a[1] === 'create')!;
    assert.equal(create[2], 'acme/app');
    assert.ok(create.includes('--private'), '반드시 비공개로 만든다');
    assert.ok(!create.includes('--public'));
    const bare = originUrl(dir)!;
    assert.equal(git(bare, 'rev-parse', 'main'), git(dir, 'rev-parse', 'main'), 'main 이 push 됐다');
    assert.equal(createPrivateRemote(dir, 'app', cfg), null, 'origin 이 있으면 아무것도 하지 않는다');
  });

  it('커밋이 없는 저장소나 git 저장소가 아닌 폴더에는 원격을 만들지 않는다', () => {
    const root = makeRoot();
    const cfg = fakeGh(root);
    const plain = path.join(root, 'workspaces', 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const empty = path.join(root, 'workspaces', 'empty');
    fs.mkdirSync(empty, { recursive: true });
    git(empty, 'init', '-q', '-b', 'main');
    assert.equal(createPrivateRemote(plain, 'plain', cfg), null);
    assert.equal(createPrivateRemote(empty, 'empty', cfg), null);
    assert.equal(ghCalls(root).length, 0);
  });

  it('새 작업 공간은 main 브랜치 git 저장소로 시작하고 .env 는 제외된다', () => {
    const root = makeRoot();
    const dir = path.join(root, 'workspaces', 'fresh');
    assert.ok(initWorkspaceRepo(dir, 'fresh').ok);
    assert.equal(git(dir, 'branch', '--show-current'), 'main');
    assert.equal(git(dir, 'log', '--format=%s'), 'chore: fresh 작업 공간 초기화');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    assert.equal(git(dir, 'status', '--porcelain'), '', '.env 는 커밋 대상이 아니다');
    assert.ok(initWorkspaceRepo(dir, 'fresh').ok, '이미 저장소면 그대로 둔다');
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1');
  });

  it('비공개로 확인된 origin 에만 push 하고, 공개 저장소나 확인 못한 원격에는 push 하지 않는다', () => {
    const root = makeRoot();
    const cfg = fakeGh(root);
    const dir = repo(path.join(root, 'workspaces', 'app'));
    createPrivateRemote(dir, 'app', cfg);
    const bare = originUrl(dir)!;
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'a');
    const ok = pushToOrigin(dir, 'main', cfg)!;
    assert.ok(ok.ok, ok.message);
    assert.equal(git(bare, 'rev-parse', 'main'), git(dir, 'rev-parse', 'main'));

    fs.writeFileSync(`${bare}.vis`, 'PUBLIC');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'B');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'b');
    const pub = pushToOrigin(dir, 'main', cfg)!;
    assert.equal(pub.ok, false);
    assert.equal(pub.skipped, true);
    assert.notEqual(git(bare, 'rev-parse', 'main'), git(dir, 'rev-parse', 'main'), '공개 저장소에는 push 하지 않는다');

    fs.rmSync(`${bare}.vis`);
    const unknown = pushToOrigin(dir, 'main', cfg)!;
    assert.equal(unknown.ok, false);
    assert.ok(!unknown.skipped);
    assert.equal(pushToOrigin(repo(path.join(root, 'workspaces', 'noremote')), 'main', cfg), null, 'origin 이 없으면 할 일 없음');
  });

  it('bf task done 이 기준 브랜치에 합친 뒤 origin 에 push 하고, push 실패는 완료를 막지 않고 이력·채널에 경고한다', () => {
    const root = makeRoot();
    const remote = fakeGh(root);
    const paths = resolvePaths({ BF_ROOT: root });
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(paths.config, YAML.stringify({ worktrees: true, workspace_remote: remote }));
    const bf = (args: string[], env: Record<string, string> = {}) => {
      const out: string[] = [];
      const code = main(args, { BF_ROOT: root, ...env }, { out: (s) => out.push(s), err: (s) => out.push(s) });
      return { code, out: out.join('\n') };
    };
    const dir = repo(path.join(paths.workspaces, 'app'));
    createPrivateRemote(dir, 'app', remote);
    const bare = originUrl(dir)!;

    const work = (title: string) => {
      const board = makeBoardAt(root);
      const t = board.createTask('owner', { title, assignee: 'worker', doneWhen: ['x'], parent: null, workspace: 'app' });
      board.start(t.id);
      board.setWorktree(t.id, ensureWorktree(paths, board.read(t.id).task)!);
      fs.writeFileSync(path.join(board.read(t.id).task.worktree!.path, `${t.id}.txt`), title);
      return t.id;
    };

    const a = work('기능 A');
    const r = bf(['task', 'done', a, '--summary', '끝'], { BF_ACTOR: 'worker', BF_TASK: a });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /origin main push 완료/);
    assert.equal(git(bare, 'rev-parse', 'main'), git(dir, 'rev-parse', 'main'), '병합된 main 이 origin 에 있다');
    assert.ok(git(bare, 'ls-tree', '--name-only', 'main').includes(`${a}.txt`));

    // origin 이 사라져 push 가 실패해도 완료 보고는 그대로 된다
    const b = work('기능 B');
    git(dir, 'remote', 'set-url', 'origin', path.join(root, 'hub', 'gone.git'));
    fs.writeFileSync(path.join(root, 'hub', 'gone.git.vis'), 'PRIVATE');
    const f = bf(['task', 'done', b, '--summary', '끝'], { BF_ACTOR: 'worker', BF_TASK: b });
    assert.equal(f.code, 0, f.out);
    assert.match(f.out, /⚠️ origin main push 실패/);
    assert.match(bf(['task', 'show', b]).out, /\[engine\] 코멘트: ⚠️ 원격 push 경고/);
    assert.ok(readMessages(paths, 'c-app', 100).some((m) => m.text.includes(`${b} 작업 공간 app 원격 push 실패`)));
    assert.ok(git(dir, 'ls-tree', '--name-only', 'main').includes(`${b}.txt`), '작업 공간 main 에는 반영됐다');
  });

  it('꺼져 있으면 bf task done 은 push 하지 않는다', () => {
    const root = makeRoot();
    const remote = fakeGh(root);
    const paths = resolvePaths({ BF_ROOT: root });
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(paths.config, YAML.stringify({ worktrees: true, workspace_remote: { ...remote, enabled: false } }));
    const dir = repo(path.join(paths.workspaces, 'app'));
    createPrivateRemote(dir, 'app', remote);
    const before = ghCalls(root).length;
    const board = makeBoardAt(root);
    const t = board.createTask('owner', { title: 'x', assignee: 'worker', doneWhen: ['x'], parent: null, workspace: 'app' });
    board.start(t.id);
    assert.equal(main(['task', 'done', t.id, '--summary', 's'], { BF_ROOT: root, BF_ACTOR: 'worker', BF_TASK: t.id }, { out: () => {}, err: () => {} }), 0);
    assert.equal(ghCalls(root).length, before);
  });

  it('엔진: 새 작업 공간을 git 저장소로 만들고 비공개 원격을 연결하며, 업무 완료 후 main 을 push 한다. 기존 저장소에도 원격을 만든다', async () => {
    const root = makeRoot();
    const paths = resolvePaths({ BF_ROOT: root });
    const remote = fakeGh(root);
    const config: Config = { ...DEFAULT_CONFIG, claude_command: [process.execPath, FAKE], max_attempts: 1, worktrees: true, workspace_remote: remote };
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(paths.config, YAML.stringify(config));
    const old = repo(path.join(paths.workspaces, 'old'));
    fs.mkdirSync(path.join(paths.workspaces, 'notgit'), { recursive: true });
    const logs: string[] = [];
    const engine = new Engine(paths, config, {
      log: (l) => logs.push(l),
      notify: () => {},
      run: (spec) => runAgent(spec, { ...process.env, FAKE_PLAN: JSON.stringify({ worker: 'done', reviewer: 'pass' }) }),
    });
    makeBoardAt(root).createTask('owner', { title: '새 앱 만들기', assignee: 'worker', doneWhen: ['x'], parent: null, workspace: 'newapp' });
    await engine.runUntilIdle();
    engine.tick();

    const dir = path.join(paths.workspaces, 'newapp');
    assert.equal(git(dir, 'branch', '--show-current'), 'main', logs.join('\n'));
    const bare = originUrl(dir)!;
    assert.ok(bare, '새 작업 공간에 origin 이 연결됐다');
    assert.equal(git(bare, 'rev-parse', 'main'), git(dir, 'rev-parse', 'main'), '업무 완료 후 main 이 push 돼 있다');
    assert.ok(originUrl(old), '원격 없던 기존 저장소에도 원격을 만든다');
    assert.equal(originUrl(path.join(paths.workspaces, 'notgit')), null, 'git 저장소가 아닌 폴더는 건드리지 않는다');
    assert.ok(!fs.existsSync(path.join(paths.workspaces, 'notgit', '.git')));
    assert.ok(ghCalls(root).filter((a) => a[1] === 'create').every((a) => a.includes('--private')));
    assert.ok(readMessages(paths, 'c-newapp', 100).some((m) => m.text.startsWith('🔗 GitHub 비공개 저장소')));
    const creates = ghCalls(root).filter((a) => a[1] === 'create').length;
    engine.tick();
    assert.equal(ghCalls(root).filter((a) => a[1] === 'create').length, creates, '한 번 만든 뒤에는 다시 만들지 않는다');
  });
});

describe('프로젝트 채널 한 줄 소개', () => {
  it('README 첫 줄에서 서비스 설명을 뽑는다', () => {
    const { board } = makeBoard();
    const ws = (name: string, readme: string) => {
      fs.mkdirSync(path.join(board.paths.workspaces, name), { recursive: true });
      fs.writeFileSync(path.join(board.paths.workspaces, name, 'README.md'), readme);
    };
    ws('fortune', '# fortune — 매일 띠운세 + 2027 신년운세 (앱인토스 미니앱 + 정적 웹)\n\n- 미션 M001\n');
    ws('blindcandle', '# BlindCandle (trading-simulation)\n\n바이낸스 BTCUSDT 1분봉으로 매매를 연습하는 훈련 앱.\n');
    assert.equal(projectDescription(board.paths, 'fortune'), '매일 띠운세 + 2027 신년운세 (앱인토스 미니앱 + 정적 웹)');
    assert.equal(projectDescription(board.paths, 'blindcandle'), '바이낸스 BTCUSDT 1분봉으로 매매를 연습하는 훈련 앱.');
    assert.equal(projectDescription(board.paths, 'none'), null);
  });

  it('새 프로젝트 채널의 첫 메시지는 프로젝트·서비스 설명·소속 미션을 담은 한 줄 소개이고, 이미 있는 채널에는 다시 올리지 않는다', () => {
    const { board } = makeBoard();
    const paths = board.paths;
    fs.mkdirSync(path.join(paths.workspaces, 'fortune'), { recursive: true });
    fs.writeFileSync(path.join(paths.workspaces, 'fortune', 'README.md'), '# fortune — 매일 띠운세\n');
    ensureChannel(paths, 'm001');
    const conv = ensureProjectChannel(paths, 'fortune', { mission: 'M001' })!;
    const msgs = readMessages(paths, conv.id, 100);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].kind, 'system');
    assert.match(msgs[0].text, /^📌 \*\*#fortune\*\* 프로젝트 채널 — 매일 띠운세 · 미션 M001 소속 \(#m001\)/);
    assert.ok(!msgs[0].text.includes('\n'), '한 줄');
    ensureProjectChannel(paths, 'fortune', { mission: 'M001' });
    assert.equal(readMessages(paths, conv.id, 100).length, 1, '이미 있는 채널에는 다시 올리지 않는다');

    const plain = ensureProjectChannel(paths, 'tool')!;
    assert.match(readMessages(paths, plain.id, 100)[0].text, /작업 공간 tool 의 프로젝트 · 미션 소속 없음/);
  });

  it('엔진이 작업 공간·미션 프로젝트 채널을 만들 때 소개가 첫 메시지로 올라간다', () => {
    const root = makeRoot();
    const paths = resolvePaths({ BF_ROOT: root });
    const config: Config = { ...DEFAULT_CONFIG, claude_command: [process.execPath, FAKE] };
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(paths.config, YAML.stringify(config));
    fs.mkdirSync(path.join(paths.workspaces, 'alba'), { recursive: true });
    fs.writeFileSync(path.join(paths.workspaces, 'alba', 'README.md'), '# alba — 알바 월급 계산기\n');
    createMission(paths, 'owner', { title: '다음 서비스', brief: 'b', project: 'alba' }, new Date());
    const engine = new Engine(paths, config, { log: () => {}, notify: () => {}, run: (spec) => runAgent(spec, process.env) });
    engine.tick();
    const first = readMessages(paths, 'c-alba', 100)[0];
    assert.match(first.text, /^📌 \*\*#alba\*\* 프로젝트 채널 — 알바 월급 계산기 · 미션 M001 소속/);
  });
});

function makeBoardAt(root: string): Board {
  const paths = resolvePaths({ BF_ROOT: root });
  return new Board(paths, loadConfig(paths));
}
