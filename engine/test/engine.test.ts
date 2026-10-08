import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { resolvePaths } from '../src/paths.ts';
import { runAgent } from '../src/runner.ts';
import { makeRoot } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.ts', import.meta.url));

interface Invocation {
  agent: string;
  task: string;
  cwd: string;
  args: string[];
  prompt: string;
  hasApiKey: boolean;
  pathHasBin: boolean;
  actor: string;
}

function setup(plan: Record<string, string>, overrides: Partial<Config> = {}) {
  const root = makeRoot();
  const paths = resolvePaths({ BF_ROOT: root });
  const fakeLog = path.join(root, 'fake.jsonl');
  const config: Config = { ...DEFAULT_CONFIG, claude_command: [process.execPath, FAKE], ...overrides };
  const logs: string[] = [];
  const notices: { title: string; body: string }[] = [];
  const engine = new Engine(paths, config, {
    log: (l) => logs.push(l),
    notify: (n) => notices.push(n),
    run: (spec) =>
      runAgent(spec, {
        ...process.env,
        ANTHROPIC_API_KEY: 'must-be-stripped',
        FAKE_PLAN: JSON.stringify(plan),
        FAKE_LOG: fakeLog,
      }),
  });
  const calls = (): Invocation[] =>
    fs.existsSync(fakeLog)
      ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
  return { root, paths, engine, board: engine.board, calls, logs, notices };
}

function goal(board: Engine['board'], title = '목표') {
  return board.createTask('owner', { title, assignee: 'ceo', doneWhen: ['보고서'], parent: null });
}

describe('엔진', () => {
  it('목표 하나가 위임 → 실행 → 검수 → 취합 → 최종 검수까지 사람 없이 끝난다', async () => {
    const { engine, board, calls } = setup({ ceo: 'delegate', worker: 'done', reviewer: 'pass' });
    const g = goal(board);
    await engine.runUntilIdle();

    const all = board.list();
    assert.equal(all.length, 2);
    for (const t of all) assert.equal(t.status, 'done', `${t.id} ${t.status}`);
    assert.deepEqual(
      calls().map((c) => `${c.agent}:${c.task}`),
      ['ceo:T0001', 'worker:T0002', 'reviewer:T0002', 'ceo:T0001', 'reviewer:T0001'],
    );
    assert.ok(fs.existsSync(path.join(board.taskDir(g.id), 'output', 'report.md')));
    assert.match(calls()[3].prompt, /하위 업무가 모두 끝났습니다/);
  });

  it('사용자가 할 일이 생기면 한 번만 알린다', async () => {
    const { engine, board, notices } = setup({ ceo: 'done', reviewer: 'pass' });
    goal(board);
    await engine.runUntilIdle();
    engine.tick();
    engine.tick();
    assert.deepEqual(notices.map((n) => n.title), ['목표 완료 · T0001']);

    // 결재 요청은 새로 생길 때마다 알린다
    const g2 = goal(board, '두번째');
    board.start(g2.id);
    board.requestApproval('ceo', g2.id, '도메인 구매 1만원', []);
    engine.tick();
    engine.tick();
    assert.equal(notices.length, 2);
    assert.equal(notices[1].title, '결재 요청 · T0002');
    assert.match(notices[1].body, /도메인 구매 1만원[\s\S]*bf approve 2/);
  });

  it('사용량 한도와 엔진 정지도 알린다', async () => {
    const limited = setup({ ceo: 'limit' });
    goal(limited.board);
    await limited.engine.runUntilIdle();
    assert.ok(limited.notices.some((n) => n.title === '사용량 한도로 휴식'));

    const auth = setup({ ceo: 'auth' });
    goal(auth.board);
    await auth.engine.runUntilIdle();
    assert.ok(auth.notices.some((n) => n.title.startsWith('엔진 정지')));
  });

  it('직원은 업무 폴더에서, 정리된 환경으로, 경로 제한 권한을 받아 실행된다', async () => {
    const { engine, board, calls, paths } = setup({ ceo: 'done', reviewer: 'pass' });
    goal(board);
    await engine.runUntilIdle();
    const [work, review] = calls();

    assert.equal(path.resolve(work.cwd), path.resolve(board.taskDir('T0001')));
    assert.equal(work.hasApiKey, false, 'API 키는 지워져야 한다');
    assert.equal(work.pathHasBin, true);
    assert.equal(work.actor, 'ceo');
    assert.equal(review.actor, 'reviewer');

    const allowed = (args: string[]) => {
      const i = args.indexOf('--allowedTools');
      const out: string[] = [];
      for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
      return out;
    };
    const workRules = allowed(work.args);
    assert.ok(workRules.includes('Bash(bf:*)'));
    assert.ok(workRules.some((r) => r.startsWith('Edit(') && r.includes('T0001')));
    assert.ok(!workRules.some((r) => /^(Read|Write|Edit|Bash)$/.test(r)), '경로 없는 파일 권한 금지');
    assert.ok(!allowed(review.args).some((r) => r.startsWith('Edit(')), '검수자는 읽기만');
    assert.ok(work.args.includes('--strict-mcp-config'));
    assert.equal(work.args[work.args.indexOf('--permission-mode') + 1], 'dontAsk');
    void paths;
  });

  it('보고 없이 끝나면 재시도하고, 한도를 넘으면 실패한다', async () => {
    const { engine, board, calls } = setup({ ceo: 'silent' }, { max_attempts: 2 });
    goal(board);
    await engine.runUntilIdle();
    assert.equal(board.read('T0001').task.status, 'failed');
    assert.equal(calls().length, 2);
    assert.match(board.readLog('T0001'), /보고 없이 종료/);
  });

  it('검수 반려 시 담당자가 다시 일하고 재검수한다', async () => {
    const { engine, board, calls } = setup({ ceo: 'done', reviewer: 'reject-once' });
    goal(board);
    await engine.runUntilIdle();
    assert.equal(board.read('T0001').task.status, 'done');
    assert.deepEqual(calls().map((c) => c.agent), ['ceo', 'reviewer', 'ceo', 'reviewer']);
    assert.match(calls()[2].prompt, /반려되었거나/);
  });

  it('사용량 한도에 걸리면 시도 횟수를 쓰지 않고 리셋 시각까지 멈춘다', async () => {
    const { engine, board, calls } = setup({ ceo: 'limit' });
    goal(board);
    await engine.runUntilIdle();
    const t = board.read('T0001').task;
    assert.equal(t.status, 'pending');
    assert.equal(t.attempts, 0);
    assert.equal(calls().length, 1);
    assert.ok(engine.pausedUntilTime);
    engine.tick();
    assert.equal(calls().length, 1, '대기 중에는 실행하지 않는다');
  });

  it('인증 오류는 엔진을 멈춘다', async () => {
    const { engine, board } = setup({ ceo: 'auth' });
    goal(board);
    await engine.runUntilIdle();
    assert.match(engine.halted ?? '', /인증 오류/);
    assert.equal(board.read('T0001').task.status, 'pending');
  });

  it('동시 실행 상한과 작업 공간 독점을 지킨다', async () => {
    const { engine, board, calls } = setup({ ceo: 'delegate', worker: 'done', reviewer: 'pass' }, { max_concurrency: 2 });
    for (const ws of ['a', 'a', 'b']) {
      board.createTask('owner', { title: ws, assignee: 'worker', doneWhen: ['x'], parent: null, workspace: ws });
    }
    engine.recover();
    engine.tick();
    // a 작업 공간은 한 명만 → T0001(a), T0003(b)
    await engine.drain();
    const first = calls().map((c) => c.task);
    assert.deepEqual(first.sort(), ['T0001', 'T0003']);
  });

  it('재시작 시 진행 중으로 남은 업무를 대기로 되돌린다', () => {
    const { engine, board } = setup({});
    goal(board);
    board.start('T0001');
    engine.recover();
    const t = board.read('T0001').task;
    assert.equal(t.status, 'pending');
    assert.equal(t.attempts, 0);
  });
});
