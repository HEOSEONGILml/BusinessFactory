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

function setup(plan: Record<string, string>, overrides: Partial<Config> = {}, extraEnv: Record<string, string> = {}) {
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
        ...extraEnv,
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

  it('직원의 활동을 실시간으로 기록한다', async () => {
    const { engine, board, logs } = setup({ ceo: 'done', reviewer: 'pass' });
    goal(board);
    await engine.runUntilIdle();
    assert.ok(logs.some((l) => l.includes('T0001 ceo ▸ 쓰기 output')), logs.join('\n'));
    assert.ok(logs.some((l) => l.includes('T0001 ceo ▸ 💬 ceo 작업 중')));
    const activity = fs.readFileSync(path.join(board.taskDir('T0001'), 'activity.log'), 'utf8');
    assert.match(activity, /\[ceo\] 쓰기 output/);
    assert.match(activity, /\[reviewer\] 쓰기 output/);
  });

  it('구독 사용량이 상한을 넘으면 새 업무를 시작하지 않는다', async () => {
    const { engine, board, calls, notices, paths } = setup({ ceo: 'done', reviewer: 'pass' }, {}, { FAKE_UTIL: '0.95' });
    goal(board);
    goal(board, '두번째');
    await engine.runUntilIdle();
    assert.equal(calls().length, 2, '이미 시작한 두 건만 끝내고 멈춘다');
    assert.ok(engine.pausedUntilTime);
    assert.ok(notices.some((n) => n.title === '사용량 상한으로 휴식'));
    const snap = JSON.parse(fs.readFileSync(path.join(paths.company, '.engine-usage.json'), 'utf8'));
    assert.equal(snap.windows.five_hour.utilization, 0.95);
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

describe('처리할 일 코멘트', () => {
  function asked(board: Engine['board'], items: string[] = []) {
    const g = goal(board, '질문 목표');
    board.start(g.id);
    board.ask('ceo', g.id, items.length ? '' : '도메인은 무엇으로 할까요?', true, items);
    return g.id;
  }

  it('사용자가 코멘트를 달면 담당자가 바로 코멘트로 답하고, 업무는 그대로 질문 대기다', async () => {
    const { engine, board, calls, notices } = setup({});
    const id = asked(board);
    board.threadPost('owner', id, '후보를 몇 개 보여 주세요');
    await engine.runUntilIdle();

    const thread = board.openThread(id);
    assert.deepEqual(thread.map((e) => [e.from, e.text]), [
      ['owner', '후보를 몇 개 보여 주세요'],
      ['ceo', 'ceo 확인: 후보를 몇 개 보여 주세요'],
    ]);
    assert.equal(board.read(id).task.status, 'blocked');
    const run = calls().find((c) => c.prompt.startsWith('[코멘트]'))!;
    assert.equal(run.agent, 'ceo');
    assert.ok(!run.args.join(' ').includes('Edit('), '코멘트 답변은 읽기 전용');
    assert.ok(notices.some((n) => n.title.startsWith(`코멘트 · ${id}`)));

    // 새 코멘트가 없으면 다시 답하지 않는다
    await engine.runUntilIdle();
    assert.equal(board.openThread(id).length, 2);
    board.threadPost('owner', id, '.com 으로 갑시다');
    await engine.runUntilIdle();
    assert.equal(board.openThread(id).length, 4);
  });

  it('답변 확정 때 코멘트 전체가 답변으로 넘어가고 스레드는 비워진다', () => {
    const { board } = setup({});
    const id = asked(board);
    board.threadPost('owner', id, '후보를 보여 주세요');
    board.threadPost('ceo', id, 'a.com, b.com 이 있습니다');
    board.answer('owner', id, '');
    assert.equal(board.read(id).task.status, 'pending');
    assert.deepEqual(board.openThread(id), []);
    assert.match(board.readLog(id), /답변: 코멘트로 나눈 내용:[\s\S]*\*\*사용자\*\*: 후보를 보여 주세요[\s\S]*\*\*ceo\*\*: a\.com, b\.com/);
    assert.throws(() => board.threadPost('owner', id, '늦은 코멘트'), /처리할 일이 아닙니다/);
  });

  it('질문이 여러 건이면 건마다 따로 이야기하고 따로 확정한다', async () => {
    const { engine, board } = setup({});
    const id = asked(board, ['가입', '결제']);
    board.threadPost('owner', id, '가입은 어디서요?', 1);
    await engine.runUntilIdle();
    assert.equal(board.openThread(id, 1).length, 2);
    assert.equal(board.openThread(id, 2).length, 0);
    board.answer('owner', id, '가입했습니다', 1);
    assert.equal(board.openThread(id).length, 0);
    assert.throws(() => board.threadPost('owner', id, 'x', 1), /처리할 일이 아닙니다/);
    board.threadPost('owner', id, '결제는 다음 주에', 2);
    assert.equal(board.read(id).task.status, 'blocked');
  });

  it('결재와 끝난 목표에도 코멘트를 달 수 있고, 결정하면 스레드가 닫힌다', () => {
    const { board } = setup({});
    const a = goal(board, '결재 목표');
    board.start(a.id);
    board.requestApproval('ceo', a.id, '도메인 구매', []);
    board.threadPost('owner', a.id, '얼마예요?');
    board.approve('owner', a.id, '', () => {});
    assert.deepEqual(board.openThread(a.id), []);

    const t = goal(board, '진행 중 목표');
    assert.throws(() => board.threadPost('owner', t.id, '어때요?'), /처리할 일이 아닙니다/);
    assert.throws(() => board.threadPost('worker', a.id, '끼어들기'), /사용자와 ceo 만/);
  });
});

describe('사용자 업무', () => {
  function delegated(board: Engine['board']) {
    const g = goal(board, '운영 인수');
    board.start(g.id);
    const signup = board.createTask('ceo', { title: '콘솔 가입', assignee: 'owner', doneWhen: ['appName 을 알려 준다'], parent: g.id });
    const ask = board.createTask('ceo', { title: '토스 문의', assignee: 'owner', doneWhen: ['답변 원문'], dependsOn: [signup.id], parent: g.id });
    const dev = board.createTask('ceo', { title: '미니앱 전환', assignee: 'worker', doneWhen: ['빌드 통과'], parent: g.id });
    return { g, signup, ask, dev };
  }

  it('엔진은 사용자 업무를 실행하지 않고, 그동안 다른 하위 업무는 진행된다', async () => {
    const { engine, board, calls } = setup({ worker: 'done', reviewer: 'pass' });
    const { g, signup, dev } = delegated(board);
    board.finishRun(g.id, '위임');
    await engine.runUntilIdle();
    assert.equal(board.read(dev.id).task.status, 'done');
    assert.equal(board.read(signup.id).task.status, 'pending');
    assert.equal(board.read(signup.id).task.review, false);
    assert.equal(board.read(g.id).task.status, 'waiting');
    assert.ok(!calls().some((c) => c.task === signup.id));
  });

  it('사용자가 코멘트를 달면 맡긴 직원이 답하고, 완료 보고로 끝내면 상위가 깨어난다', async () => {
    const { engine, board } = setup({ worker: 'done', reviewer: 'pass' });
    const { g, signup, ask, dev } = delegated(board);
    board.finishRun(g.id, '위임');
    board.threadPost('owner', signup.id, '앱 유형은 게임이 맞나요?');
    await engine.runUntilIdle();
    assert.deepEqual(board.openThread(signup.id).map((e) => e.from), ['owner', 'ceo']);
    assert.throws(() => board.done('ceo', signup.id, '대신 끝냄'), /담당자는 owner/);

    board.done('owner', signup.id, 'appName blindcandle');
    assert.equal(board.read(signup.id).task.status, 'done');
    assert.match(board.readLog(signup.id), /완료보고: 코멘트로 나눈 내용:[\s\S]*게임이 맞나요[\s\S]*\*\*사용자 \(최종\)\*\*: appName blindcandle/);
    assert.deepEqual(board.openThread(signup.id), []);
    board.cancel('owner', ask.id, '토스 문의는 하지 않기로');
    assert.equal(board.read(dev.id).task.status, 'done');
    assert.equal(board.read(g.id).task.status, 'pending');
  });

  it('사용자 업무는 하위 업무로만 만들 수 있다', () => {
    const { board } = setup({});
    assert.throws(
      () => board.createTask('owner', { title: 'x', assignee: 'owner', doneWhen: ['x'], parent: null }),
      /하위 업무로만/,
    );
  });
});

describe('완료 해제', () => {
  it('끝낸 사용자 업무를 다시 열면 코멘트가 이어지고, 이전 코멘트와 이력은 남는다', async () => {
    const { engine, board } = setup({});
    const g = goal(board, '운영');
    board.start(g.id);
    const t = board.createTask('ceo', { title: '콘솔 가입', assignee: 'owner', doneWhen: ['appName'], parent: g.id });
    const other = board.createTask('ceo', { title: '키 발급', assignee: 'owner', doneWhen: ['넣었음'], parent: g.id });
    board.finishRun(g.id, '위임');
    board.threadPost('owner', t.id, '게임인가요?');
    board.threadPost('ceo', t.id, '비게임입니다');
    board.done('owner', t.id, '가입했어');

    // 기록은 지우지 않고 닫아 둔다
    assert.deepEqual(board.openThread(t.id), []);
    assert.deepEqual(board.thread(t.id).map((e) => [e.from, e.event ?? null, !!e.closed]), [
      ['owner', null, true], ['ceo', null, true], ['owner', 'closed', false],
    ]);
    assert.throws(() => board.threadPost('owner', t.id, '정정'), /처리할 일이 아닙니다/);
    assert.throws(() => board.reopen('ceo', t.id), /사용자만/);
    assert.throws(() => board.reopen('owner', g.id), /사용자 업무가 아니라서/);

    board.reopen('owner', t.id);
    assert.equal(board.read(t.id).task.status, 'pending');
    assert.match(board.readLog(g.id), /정정: 사용자가 .* 의 완료를 해제/);
    board.threadPost('owner', t.id, 'appName 은 blindcandle 이야');
    await engine.runUntilIdle();
    assert.deepEqual(board.openThread(t.id).map((e) => e.from), ['owner', 'ceo']);

    board.done('owner', t.id, '');
    assert.match(board.readLog(t.id), /완료보고: 코멘트로 나눈 내용:[\s\S]*appName 은 blindcandle/);
    board.done('owner', other.id, '넣었음');
    assert.equal(board.read(g.id).task.status, 'pending');
  });

  it('상위 업무가 이미 끝났으면 다시 열 수 없다', () => {
    const { board } = setup({});
    const g = goal(board);
    board.start(g.id);
    const t = board.createTask('ceo', { title: '가입', assignee: 'owner', doneWhen: ['x'], parent: g.id });
    board.done('owner', t.id, '했음');
    board.cancel('owner', g.id);
    assert.throws(() => board.reopen('owner', t.id), /상위 업무 .* 이미 취소/);
  });
});
