import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { BoardError } from '../src/board.ts';
import { readMessages } from '../src/chat.ts';
import { main } from '../src/cli.ts';
import { DEFAULT_CONFIG, DEFAULT_MISSIONS, loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { createMission, journalFile, listMissions, missionSteps, nextJudgement, readJournal, readMission, stopMission } from '../src/missions.ts';
import { resolvePaths } from '../src/paths.ts';
import { runAgent } from '../src/runner.ts';
import { DONE_WHEN, makeBoard, makeRoot } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.ts', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../../templates', import.meta.url));

interface Call {
  agent: string;
  task: string;
  prompt: string;
}

function setup(
  plan: Record<string, string>,
  overrides: Partial<Config> = {},
  extraEnv: Record<string, string> = {},
  clock: { t: number } | null = null,
) {
  const root = makeRoot();
  fs.cpSync(TEMPLATES, path.join(root, 'templates'), { recursive: true });
  const paths = resolvePaths({ BF_ROOT: root });
  const fakeLog = path.join(root, 'fake.jsonl');
  const config: Config = {
    ...DEFAULT_CONFIG,
    claude_command: [process.execPath, FAKE],
    max_attempts: 1,
    ...overrides,
    missions: { ...DEFAULT_MISSIONS, ...(overrides.missions ?? {}) },
  };
  fs.writeFileSync(paths.config, YAML.stringify(config));
  const logs: string[] = [];
  const notices: { title: string; body: string }[] = [];
  const engine = new Engine(paths, config, {
    log: (l) => logs.push(l),
    notify: (n) => notices.push(n),
    now: clock ? () => new Date(clock.t) : undefined,
    run: (spec) => runAgent(spec, { ...process.env, FAKE_PLAN: JSON.stringify(plan), FAKE_LOG: fakeLog, ...extraEnv }),
  });
  const calls = (): Call[] =>
    fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const bf = (args: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(args, { BF_ROOT: root, ...env }, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { root, paths, config, engine, board: engine.board, calls, logs, notices, bf };
}

function addUsage(paths: ReturnType<typeof resolvePaths>, task: string, cost: number, at: Date) {
  fs.appendFileSync(
    path.join(paths.company, 'usage.jsonl'),
    JSON.stringify({ at: at.toISOString(), task, project: null, kind: 'work', agent: 'ceo', models: [], turns: 1, duration_ms: 1, cost_usd_estimate: cost, error: false }) + '\n',
  );
}

const ownerDm = (paths: ReturnType<typeof resolvePaths>) => readMessages(paths, 'd-ceo--owner', 500);

describe('미션 루프', () => {
  it('단계 목표를 자동으로 만들고, 끝나면 기록한 뒤 다음 단계를 만든다. 달성 제안은 검수 통과 후에만 확정된다', async () => {
    const { engine, board, paths, notices } = setup({ ceo: 'step', worker: 'done', reviewer: 'pass' }, {}, { FAKE_ACHIEVE_AT: '2' });
    const m = createMission(paths, 'owner', { title: 'MAU 1000', brief: '성공 기준: 주간 활성 1000' }, new Date());
    await engine.runUntilIdle();

    const steps = missionSteps(board.list(), m.id);
    assert.equal(steps.length, 2, '달성되면 더 만들지 않는다');
    assert.ok(steps.every((s) => s.status === 'done' && s.assignee === 'ceo' && s.created_by === 'owner'));
    assert.match(steps[0].title, /^\[M001\] 단계 1/);
    // The previous step's hand-over line names the next step.
    assert.equal(steps[1].title, '[M001] 단계 2: 랜딩 페이지 개선 2');
    // Subtasks inherit the mission.
    const kids = board.list().filter((t) => t.parent !== null);
    assert.ok(kids.length >= 2 && kids.every((k) => k.mission === m.id));
    assert.equal(readMission(paths, m.id).mission.status, 'achieved');
    const journal = readJournal(paths, m.id);
    assert.match(journal, /단계 1 · T0001 · 완료/);
    assert.match(journal, /다음: 랜딩 페이지 개선 2/);
    assert.match(journal, /달성 제안: 성공 기준 충족/);
    // Step results don't pile up in the owner's inbox; the mission reports go to the ceo DM instead.
    assert.ok(!notices.some((n) => n.title.startsWith('목표 완료')));
    assert.ok(!steps.some((s) => board.awaitsOwner(s)));
    const dm = ownerDm(paths);
    assert.ok(dm.some((x) => x.kind === 'system' && /미션 M001 달성/.test(x.text)));
    assert.ok(dm.every((x) => x.kind === 'system'), '보고에는 답장 실행이 붙지 않는다');
    assert.ok(notices.some((n) => n.title === '미션 M001 달성'));
  });

  it('달성 제안이 검수에서 반려되면 제안이 취소되고 미션은 계속된다', () => {
    const { board, paths, bf } = setup({});
    const m = createMission(paths, 'owner', { title: 'm', brief: 'b' }, new Date());
    const step = board.createTask('owner', { title: '[M001] 단계 1', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null, mission: m.id });
    board.start(step.id);
    const r = bf(['mission', 'achieve', 'M001', '--summary', '다 했음'], { BF_ACTOR: 'ceo', BF_TASK: step.id });
    assert.equal(r.code, 0, r.err);
    assert.equal(readMission(paths, m.id).mission.status, 'active', '검수 전에는 확정되지 않는다');
    assert.equal(board.read(step.id).task.mission_proposal?.kind, 'achieve');
    board.done('ceo', step.id, '보고');
    board.reject('reviewer', step.id, '성공 기준 미달');
    assert.equal(board.read(step.id).task.mission_proposal, null);
    assert.equal(readMission(paths, m.id).mission.status, 'active');
  });

  it('단계가 연속 2번 실패하면 일시정지하고 사용자에게 알린다', async () => {
    const { engine, board, paths, notices } = setup({ ceo: 'silent', reviewer: 'pass' });
    const m = createMission(paths, 'owner', { title: 'm', brief: 'b' }, new Date());
    await engine.runUntilIdle();
    const steps = missionSteps(board.list(), m.id);
    assert.deepEqual(steps.map((s) => s.status), ['failed', 'failed']);
    const after = readMission(paths, m.id).mission;
    assert.equal(after.status, 'paused');
    assert.match(after.paused_reason ?? '', /연속 2번 실패/);
    assert.ok(notices.some((n) => n.title === '미션 M001 일시정지'));
    // Failed steps stay in the inbox.
    assert.ok(steps.every((s) => board.awaitsOwner(s)));
  });

  it('빈 단계(끝난 하위 업무도 산출물도 없음)가 연속 2번이면 일시정지한다', async () => {
    const { engine, board, paths } = setup({ ceo: 'empty-step', reviewer: 'pass' });
    const m = createMission(paths, 'owner', { title: 'm', brief: 'b' }, new Date());
    await engine.runUntilIdle();
    assert.equal(missionSteps(board.list(), m.id).length, 2);
    assert.match(readMission(paths, m.id).mission.paused_reason ?? '', /진전 없음/);
  });

  it('예산을 넘으면 진행 중 단계의 새 업무도 시작하지 않고, 7일 창이 지나면 자동으로 이어 간다', async () => {
    const clock = { t: Date.now() };
    const { engine, board, paths, notices } = setup(
      { ceo: 'step', worker: 'done', reviewer: 'pass' },
      { missions: { ...DEFAULT_MISSIONS, weekly_budget_usd: 0.025 } },
      { FAKE_ACHIEVE_AT: '1' },
      clock,
    );
    const m = createMission(paths, 'owner', { title: 'm', brief: 'b' }, new Date(clock.t));
    await engine.runUntilIdle();
    // ceo (0.01) + worker (0.01) + worker review (0.01) > 0.025: the ceo's wrap-up run waits.
    let step = missionSteps(board.list(), m.id)[0];
    assert.equal(step.status, 'pending');
    assert.equal(readMission(paths, m.id).mission.hold, 'budget');
    assert.ok(notices.some((n) => n.title === '미션 M001 대기'));

    // An owner goal still runs while the mission waits.
    const g = board.createTask('owner', { title: '사용자 목표', assignee: 'worker', doneWhen: DONE_WHEN, parent: null });
    await engine.runUntilIdle();
    assert.equal(board.read(g.id).task.status, 'done');
    assert.equal(missionSteps(board.list(), m.id)[0].status, 'pending');

    clock.t += 8 * 86_400_000;
    await engine.runUntilIdle();
    step = missionSteps(board.list(), m.id)[0];
    assert.equal(step.status, 'done');
    assert.equal(readMission(paths, m.id).mission.status, 'achieved');
    assert.ok(notices.some((n) => n.title === '미션 M001 재개'));
  });

  it('구독 7일 사용률이 미션 상한 이상이면 미션 업무를 쉬고, 기록이 오래되면 한 건을 보내 새 값을 받아 온다', () => {
    const clock = { t: Date.now() };
    const started: string[] = [];
    const { root, paths } = setup({});
    const config: Config = { ...DEFAULT_CONFIG, missions: { ...DEFAULT_MISSIONS } };
    const engine = new Engine(paths, config, {
      log: () => {},
      notify: () => {},
      now: () => new Date(clock.t),
      run: (spec) => {
        started.push(spec.env.BF_TASK);
        return new Promise(() => {}); // never finishes: we only look at what starts
      },
    });
    void root;
    const snap = (at: number) =>
      fs.writeFileSync(
        path.join(paths.company, '.engine-usage.json'),
        JSON.stringify({ at: new Date(at).toISOString(), status: 'allowed', windows: { seven_day: { utilization: 0.75, resetsAt: Math.floor(clock.t / 1000) + 5 * 86400 } } }),
      );
    snap(clock.t);
    const m = createMission(paths, 'owner', { title: 'm', brief: 'b' }, new Date(clock.t));
    engine.tick();
    assert.equal(missionSteps(engine.board.list(), m.id).length, 0, '상한 이상이면 단계를 만들지 않는다');
    assert.equal(readMission(paths, m.id).mission.hold, 'ceiling');

    // The figure is now 7 hours old: one step starts as a probe.
    clock.t += 7 * 3_600_000;
    engine.tick();
    const steps = missionSteps(engine.board.list(), m.id);
    assert.equal(steps.length, 1);
    assert.deepEqual(started, [steps[0].id]);
  });

  it('사용자 목표가 미션 업무보다 먼저 시작하고, 미션 업무는 슬롯 상한을 넘지 않는다', () => {
    const started: string[] = [];
    const { paths } = setup({});
    const config: Config = { ...DEFAULT_CONFIG, max_concurrency: 2, missions: { ...DEFAULT_MISSIONS } };
    const engine = new Engine(paths, config, {
      log: () => {},
      notify: () => {},
      run: (spec) => {
        started.push(spec.env.BF_TASK);
        return new Promise(() => {});
      },
    });
    const board = engine.board;
    const m1 = createMission(paths, 'owner', { title: 'a', brief: 'a' }, new Date());
    const m2 = createMission(paths, 'owner', { title: 'b', brief: 'b' }, new Date());
    // Steps already waiting, with a high task priority that must not jump ahead of the owner's goal.
    const s1 = board.createTask('owner', { title: '[M001] 단계 1', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null, mission: m1.id, priority: 9 });
    const s2 = board.createTask('owner', { title: '[M002] 단계 1', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null, mission: m2.id, priority: 9 });
    const g = board.createTask('owner', { title: '사용자 목표', assignee: 'worker', doneWhen: DONE_WHEN, parent: null });
    engine.tick();
    // Two slots: the owner's goal first, then one mission task (max_slots = max_concurrency - 1).
    assert.deepEqual(started, [g.id, s1.id]);
    assert.equal(board.read(s2.id).task.status, 'pending');
  });

  it('하위 업무가 계속 늘어나면 경보만 보내고 멈추지 않는다', () => {
    const { board, paths, engine, notices } = setup({}, { missions: { ...DEFAULT_MISSIONS, step_task_alert: 2 } });
    const m = createMission(paths, 'owner', { title: 'm', brief: 'b' }, new Date());
    const step = board.createTask('owner', { title: '[M001] 단계 1', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null, mission: m.id });
    for (let i = 0; i < 3; i++) board.createTask('owner', { title: `일 ${i}`, assignee: 'worker', doneWhen: DONE_WHEN, parent: step.id });
    engine.board.list(); // no runs needed
    (engine as unknown as { missions: { tick(): void } }).missions.tick();
    (engine as unknown as { missions: { tick(): void } }).missions.tick();
    assert.equal(notices.filter((n) => n.title === '미션 M001 경보').length, 1, '한 번만 알린다');
    assert.equal(readMission(paths, m.id).mission.status, 'active');
  });

  it('사용자가 단계를 취소하면 미션은 일시정지, stop --cancel-running 이면 중지', () => {
    const { board, paths, engine } = setup({});
    const tick = () => (engine as unknown as { missions: { tick(): void } }).missions.tick();
    const m = createMission(paths, 'owner', { title: 'm', brief: 'b' }, new Date());
    tick();
    const [step] = missionSteps(board.list(), m.id);
    board.cancel('owner', step.id, '방향이 틀림');
    tick();
    assert.equal(readMission(paths, m.id).mission.status, 'paused');
    assert.equal(missionSteps(board.list(), m.id).length, 1, '다음 단계를 만들지 않는다');

    const m2 = createMission(paths, 'owner', { title: 'm2', brief: 'b' }, new Date());
    tick();
    const [step2] = missionSteps(board.list(), m2.id);
    stopMission(board, m2.id, 'owner', '그만', true, new Date());
    tick();
    assert.equal(board.read(step2.id).task.status, 'canceled');
    assert.equal(readMission(paths, m2.id).mission.status, 'stopped');
    assert.match(fs.readFileSync(journalFile(paths, m2.id), 'utf8'), /단계 1 · T\d+ · 취소/);
  });

  it('기한이 지나면 새 단계를 만들지 않고 중지하며 최종 보고를 조립한다', () => {
    const { board, paths, engine } = setup({});
    const m = createMission(paths, 'owner', { title: 'm', brief: 'b', until: '2020-01-01' }, new Date());
    (engine as unknown as { missions: { tick(): void } }).missions.tick();
    assert.equal(missionSteps(board.list(), m.id).length, 0);
    assert.equal(readMission(paths, m.id).mission.status, 'stopped');
    assert.ok(ownerDm(paths).some((x) => /미션 M001 종료/.test(x.text) && /기한\(2020-01-01\) 도래/.test(x.text)));
  });

  it('정기 보고는 정해진 시각에 한 번, LLM 실행 없이 사용자 DM 에 올라간다', () => {
    const clock = { t: new Date(2026, 9, 12, 8, 58).getTime() };
    const runs: string[] = [];
    const { paths } = setup({});
    const engine = new Engine(paths, { ...DEFAULT_CONFIG, missions: { ...DEFAULT_MISSIONS } }, {
      log: () => {},
      notify: () => {},
      now: () => new Date(clock.t),
      startEnabled: true,
      run: (spec) => {
        runs.push(spec.env.BF_TASK);
        return new Promise(() => {});
      },
    });
    createMission(paths, 'owner', { title: '보고 미션', brief: 'b' }, new Date(clock.t));
    const tick = () => (engine as unknown as { missions: { tick(): void } }).missions.tick();
    tick();
    clock.t += 3 * 60_000; // 09:01
    tick();
    tick();
    const reports = ownerDm(paths).filter((x) => /미션 정기 보고/.test(x.text));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].kind, 'system');
    assert.match(reports[0].text, /M001 보고 미션/);
    assert.match(reports[0].text, /현재 단계: T0001/);
    assert.deepEqual(runs, []);
  });
});

describe('미션 단계 규칙', () => {
  it('단계 담당자의 일반 질문은 거부되고 --owner 질문은 된다', () => {
    const { board, paths } = setup({});
    createMission(paths, 'owner', { title: 'm', brief: 'b' }, new Date());
    const step = board.createTask('owner', { title: '[M001] 단계 1', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null, mission: 'M001' });
    board.start(step.id);
    assert.throws(() => board.ask('ceo', step.id, '어떻게 할까요?'), /맡긴 사람이 없습니다/);
    const t = board.ask('ceo', step.id, '계정 비밀번호가 필요합니다', true);
    assert.equal(t.ask_to, 'owner');
    // Subtasks keep the normal flow: they ask whoever handed them out.
    board.answer('owner', step.id, '넣었음');
    board.start(step.id);
    const kid = board.createTask('ceo', { title: '실무', assignee: 'worker', doneWhen: DONE_WHEN, parent: step.id });
    board.start(kid.id);
    assert.equal(board.ask('worker', kid.id, '범위?').ask_to, 'ceo');
  });

  it('--plan-review 는 지금 업무의 plan.md 검토를 reviewer 에게 검수 없이 맡긴다', () => {
    const { board, paths, bf } = setup({});
    createMission(paths, 'owner', { title: 'm', brief: 'b' }, new Date());
    const step = board.createTask('owner', { title: '[M001] 단계 1', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null, mission: 'M001' });
    board.start(step.id);
    const env = { BF_ACTOR: 'ceo', BF_TASK: step.id };
    const missing = bf(['task', 'create', '--plan-review'], env);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /plan\.md/);
    fs.writeFileSync(path.join(board.taskDir(step.id), 'output', 'plan.md'), '# 계획');
    const r = bf(['task', 'create', '--plan-review', '--desc', '외부 공개 위험을 특히 보라'], env);
    assert.equal(r.code, 0, r.err);
    const review = board.children(step.id)[0];
    assert.equal(review.assignee, 'reviewer');
    assert.equal(review.review, false);
    assert.equal(review.mission, 'M001');
    const body = board.read(review.id).body;
    assert.match(body, /plan-review\.md/);
    assert.match(body, /외부 공개 위험을 특히 보라/);
  });

  it('검수자에게 미션 헌장과 달성 제안이 함께 전달된다', async () => {
    const { engine, board, paths, calls } = setup({ ceo: 'step', worker: 'done', reviewer: 'pass' }, {}, { FAKE_ACHIEVE_AT: '1' });
    createMission(paths, 'owner', { title: 'm', brief: '성공 판정 기준: 가입 100명' }, new Date());
    await engine.runUntilIdle();
    const stepReview = calls().find((c) => c.agent === 'reviewer' && c.task === 'T0001')!;
    assert.match(stepReview.prompt, /\[미션 단계\]/);
    assert.match(stepReview.prompt, /미션 달성을 제안/);
    assert.match(stepReview.prompt, /가입 100명/);
    assert.equal(board.read('T0001').task.status, 'done');
  });

  it('헌장은 사용자와 그 미션의 단계 담당자만 고치고, 원문은 보존된다', () => {
    const { board, paths, bf } = setup({});
    createMission(paths, 'owner', { title: 'm', brief: '한 줄 지시' }, new Date());
    const step = board.createTask('owner', { title: '[M001] 단계 1', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null, mission: 'M001' });
    board.start(step.id);
    assert.equal(bf(['mission', 'charter', 'M001', '--text', '해킹'], { BF_ACTOR: 'worker' }).code, 1);
    const r = bf(['mission', 'charter', 'M001', '--text', '목적: X\n성공 판정 기준: Y'], { BF_ACTOR: 'ceo', BF_TASK: step.id });
    assert.equal(r.code, 0, r.err);
    const { body } = readMission(paths, 'M001');
    assert.match(body, /## 원문\n\n한 줄 지시/);
    assert.match(body, /## 헌장\n\n목적: X/);
    assert.match(readJournal(paths, 'M001'), /헌장 보강 \(ceo\)/);
  });

  it('bf mission 명령: 등록·목록·조회·일시정지·재개·설정·중지 (제어는 사용자만)', () => {
    const { bf, paths } = setup({});
    assert.equal(bf(['mission', 'create', '매출 만들기', '--brief', '월 100만원'], { BF_ACTOR: 'ceo' }).code, 1);
    const c = bf(['mission', 'create', '매출 만들기', '--brief', '월 100만원', '--until', '2026-12-31', '--weight', '2']);
    assert.equal(c.code, 0, c.err);
    assert.match(c.out, /M001/);
    assert.match(bf(['mission', 'list']).out, /M001 {2}\[진행\] {2}매출 만들기/);
    assert.match(bf(['mission', 'show', '1']).out, /월 100만원/);
    assert.equal(bf(['mission', 'pause', 'M001'], { BF_ACTOR: 'ceo' }).code, 1);
    assert.equal(bf(['mission', 'pause', 'M001', '--reason', '잠깐']).code, 0);
    assert.equal(readMission(paths, 'M001').mission.status, 'paused');
    assert.equal(bf(['mission', 'resume', 'M001']).code, 0);
    assert.equal(bf(['mission', 'set', 'M001', '--weight', '3', '--until', '']).code, 0);
    const m = readMission(paths, 'M001').mission;
    assert.equal(m.weight, 3);
    assert.equal(m.until, null);
    assert.equal(bf(['mission', 'stop', 'M001']).code, 0);
    assert.equal(listMissions(paths)[0].status, 'stopped');
    assert.equal(bf(['mission', 'resume', 'M001']).code, 1);
  });

  it('다음: 줄을 찾는다', () => {
    assert.equal(nextJudgement('한 일\n다음: 가격 실험'), '가격 실험');
    assert.equal(nextJudgement('**다음**: 굵게'), '굵게');
    assert.equal(nextJudgement('없음'), '');
  });
});

describe('위임 깊이 (max_depth)', () => {
  it('기본값은 제한 없음이고, 설정에 명시적 null 이 있어도 깊은 위임이 된다', async () => {
    assert.equal(DEFAULT_CONFIG.max_depth, null);
    const root = makeRoot();
    const paths = resolvePaths({ BF_ROOT: root });
    fs.writeFileSync(paths.config, 'max_depth: null\nmax_attempts: 3\n');
    const config = loadConfig(paths);
    assert.equal(config.max_depth, null);
    const fakeLog = path.join(root, 'fake.jsonl');
    const engine = new Engine(paths, { ...config, claude_command: [process.execPath, FAKE] }, {
      log: () => {},
      notify: () => {},
      run: (spec) => runAgent(spec, { ...process.env, FAKE_PLAN: JSON.stringify({ worker: 'deep', reviewer: 'pass' }), FAKE_LOG: fakeLog, FAKE_DEPTH: '6' }),
    });
    const g = engine.board.createTask('owner', { title: '깊게', assignee: 'worker', doneWhen: DONE_WHEN, parent: null });
    await engine.runUntilIdle();
    const all = engine.board.list();
    assert.equal(Math.max(...all.map((t) => t.depth)), 6);
    assert.ok(all.every((t) => t.status === 'done'), all.map((t) => `${t.id}:${t.status}`).join(' '));
    assert.equal(engine.board.read(g.id).task.status, 'done');
  });

  it('설정 키가 없어도 제한 없음, 숫자를 넣으면 예전처럼 막는다 (하위 호환)', () => {
    const root = makeRoot();
    const paths = resolvePaths({ BF_ROOT: root });
    fs.writeFileSync(paths.config, 'max_attempts: 3\n');
    assert.equal(loadConfig(paths).max_depth, null);
    const { board } = makeBoard({ max_depth: 1 });
    const g = board.createTask('owner', { title: 'g', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null });
    const t = board.createTask('ceo', { title: 't', assignee: 'worker', doneWhen: DONE_WHEN, parent: g.id });
    assert.throws(() => board.createTask('worker', { title: 'tt', assignee: 'worker', doneWhen: DONE_WHEN, parent: t.id }), BoardError);
  });

  it('미션 필드가 없는 옛 업무와 missions 블록이 없는 옛 설정도 그대로 읽힌다', () => {
    const root = makeRoot();
    const paths = resolvePaths({ BF_ROOT: root });
    fs.writeFileSync(paths.config, 'max_depth: 3\nmax_concurrency: 3\n');
    const config = loadConfig(paths);
    assert.equal(config.max_depth, 3);
    assert.deepEqual(config.missions, DEFAULT_MISSIONS);
    const dir = path.join(paths.board, 'T0001');
    fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'task.md'),
      '---\nid: T0001\ntitle: 옛 목표\nstatus: done\nassignee: ceo\ncreated_by: owner\nparent: null\ndepends_on: []\ndepth: 0\nreview: true\nworkspace: null\nproject: null\npriority: 0\nattempts: 1\nmax_attempts: 3\nrejections: 0\nmax_rejections: 3\nask_to: null\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\n---\n## 설명\n\n옛\n',
    );
    const engine = new Engine(paths, config, { log: () => {}, notify: () => {}, run: () => new Promise(() => {}) });
    const t = engine.board.read('T0001').task;
    assert.equal(t.mission, undefined);
    assert.ok(engine.board.awaitsOwner(t), '옛 끝난 목표는 여전히 처리할 일에 있다');
    engine.tick();
  });
});
