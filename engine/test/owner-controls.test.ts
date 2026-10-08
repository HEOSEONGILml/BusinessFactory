import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listAgents } from '../src/agents.ts';
import { main } from '../src/cli.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { ownerItems } from '../src/notify.ts';
import { resolvePaths } from '../src/paths.ts';
import { runAgent } from '../src/runner.ts';
import { readStaff, removeStaff, saveStaff } from '../src/staff.ts';
import { buildState } from '../src/web.ts';
import { DONE_WHEN, makeBoard, makeRoot } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.ts', import.meta.url));

describe('건별 질문', () => {
  function asked() {
    const { board, root } = makeBoard();
    const g = board.createTask('owner', { title: '인수인계', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null });
    board.start(g.id);
    board.ask('ceo', g.id, '처리 부탁드립니다', true, ['R9 콘솔 가입', 'R10 토스 문의', 'R11 키 발급']);
    return { board, root, id: g.id };
  }

  it('건마다 따로 보이고 따로 알린다', () => {
    const { board, root, id } = asked();
    const paths = resolvePaths({ BF_ROOT: root });
    const state = buildState(board, paths, { running: false, pausedUntil: null, halted: null });
    assert.deepEqual(state.inbox.questions.map((q) => `${q.item}/${q.total} ${q.question}`), ['1/3 R9 콘솔 가입', '2/3 R10 토스 문의', '3/3 R11 키 발급']);
    assert.deepEqual(ownerItems(board).map((i) => i.notice.title), ['질문 · T0001 (1/3)', '질문 · T0001 (2/3)', '질문 · T0001 (3/3)']);
    assert.equal(board.read(id).task.status, 'blocked');
  });

  it('한 건씩 답하고, 모두 답해야 다시 시작한다', () => {
    const { board, id } = asked();
    assert.throws(() => board.answer('owner', id, '했음'), /몇 번째 질문/);
    assert.equal(board.answer('owner', id, 'appName blindcandle', 1).status, 'blocked');
    assert.equal(ownerItems(board).length, 2, '답한 건은 알림에서 빠진다');
    board.answer('owner', id, '문의 보냄', 2);
    const t = board.answer('owner', id, '넣었음', 3);
    assert.equal(t.status, 'pending');
    assert.equal(t.questions, null);
    assert.match(board.readLog(id), /답변 1\/3: appName blindcandle[\s\S]*답변 3\/3: 넣었음[\s\S]*모든 질문에 답변/);
  });

  it('명령어로도 건별로 묻고 답한다', () => {
    const root = makeRoot();
    const io = { out: () => {}, err: () => {} };
    main(['goal', '목표'], { BF_ROOT: root }, io);
    const paths = resolvePaths({ BF_ROOT: root });
    const engine = new Engine(paths, DEFAULT_CONFIG, { log: () => {}, notify: () => {} });
    engine.board.start('T0001');
    assert.equal(main(['task', 'ask', '1', '--owner', '--item', 'A', '--item', 'B'], { BF_ROOT: root, BF_ACTOR: 'ceo', BF_TASK: '1' }, io), 0);
    assert.equal(main(['task', 'answer', '1', '--item', '2', '비'], { BF_ROOT: root }, io), 0);
    assert.deepEqual(engine.board.read('T0001').task.questions?.map((q) => q.answer), [null, '비']);
  });
});

describe('엔진 스위치', () => {
  it('꺼져 있으면 일을 시작하지 않고, 켜면 시작한다', async () => {
    const { board, root } = makeBoard();
    board.createTask('owner', { title: '목표', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null });
    const paths = resolvePaths({ BF_ROOT: root });
    let runs = 0;
    const engine = new Engine(paths, { ...DEFAULT_CONFIG, claude_command: [process.execPath, FAKE] }, {
      log: () => {},
      notify: () => {},
      startEnabled: false,
      run: (spec) => {
        runs++;
        return runAgent(spec, { ...process.env, FAKE_PLAN: JSON.stringify({ ceo: 'done', reviewer: 'pass' }) });
      },
    });
    engine.recover();
    engine.tick();
    assert.equal(runs, 0);
    engine.setEnabled(true);
    engine.tick();
    assert.equal(runs, 1);
    engine.setEnabled(false);
    assert.equal(engine.runningCount, 1, '끄더라도 하던 일은 마무리한다');
    await engine.drain();
    engine.tick();
    assert.equal(runs, 1, '꺼진 뒤에는 검수도 시작하지 않는다');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.company, '.engine-state.json'), 'utf8')), { enabled: false });
  });
});

describe('직원 편집', () => {
  const input = { name: 'designer', description: '디자이너', model: 'sonnet', tools: ['Read', 'Write'], permissions: ['WebFetch'], prompt: '너는 디자이너다. 화면과 로고를 만든다. 결과물은 output/ 에 둔다.' };

  it('추가·수정이 파일과 목록에 반영된다', () => {
    const root = makeRoot();
    const paths = resolvePaths({ BF_ROOT: root });
    saveStaff(paths, input, true);
    assert.equal(readStaff(paths, 'designer').model, 'sonnet');
    saveStaff(paths, { ...input, model: 'haiku', description: '디자이너: 화면, 로고' }, false);
    const s = readStaff(paths, 'designer');
    assert.equal(s.model, 'haiku');
    assert.equal(s.description, '디자이너: 화면, 로고', '콜론이 있어도 깨지지 않는다');
    assert.deepEqual(s.permissions, ['WebFetch']);
    assert.ok(listAgents(paths).some((a) => a.name === 'designer'));
  });

  it('위험하거나 잘못된 설정은 거부한다', () => {
    const paths = resolvePaths({ BF_ROOT: makeRoot() });
    assert.throws(() => saveStaff(paths, { ...input, permissions: ['Bash'] }, true), /범위 제한이 없는/);
    assert.throws(() => saveStaff(paths, { ...input, tools: ['Shell'] }, true), /알 수 없는 도구/);
    assert.throws(() => saveStaff(paths, { ...input, model: 'gpt-5' }, true), /알 수 없는 모델/);
    assert.throws(() => saveStaff(paths, { ...input, name: 'ceo' }, true), /이미 있는 직원/);
    assert.throws(() => saveStaff(paths, { ...input, name: 'Bad Name' }, true), /직원 이름은/);
  });

  it('핵심 직원과 일이 남은 직원은 내보낼 수 없다', () => {
    const paths = resolvePaths({ BF_ROOT: makeRoot() });
    assert.throws(() => removeStaff(paths, 'ceo', ['ceo', 'reviewer'], 0), /꼭 필요한 직원/);
    assert.throws(() => removeStaff(paths, 'worker', ['ceo', 'reviewer'], 2), /끝나지 않은 업무가 2건/);
    removeStaff(paths, 'worker', ['ceo', 'reviewer'], 0);
    assert.ok(!listAgents(paths).some((a) => a.name === 'worker'));
  });
});

describe('엔진 감시', () => {
  it('정지된 엔진은 정해진 시간이 지나면 스스로 다시 가동하고, 연속이면 더 오래 기다린다', async () => {
    const { board, root } = makeBoard();
    board.createTask('owner', { title: '목표', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null });
    const paths = resolvePaths({ BF_ROOT: root });
    let clock = new Date('2026-10-08T00:00:00Z');
    const notices: string[] = [];
    let runs = 0;
    const engine = new Engine(paths, { ...DEFAULT_CONFIG, claude_command: [process.execPath, FAKE] }, {
      log: () => {},
      notify: (n) => notices.push(n.title),
      now: () => clock,
      run: (spec) => {
        runs++;
        return runAgent(spec, { ...process.env, FAKE_PLAN: JSON.stringify({ ceo: 'auth' }) });
      },
    });
    const haltOnce = async () => {
      engine.tick();
      await engine.drain();
      assert.match(engine.halted ?? '', /인증 오류/);
    };
    const later = (min: number) => (clock = new Date(clock.getTime() + min * 60_000));

    engine.recover();
    await haltOnce();
    later(9);
    engine.tick();
    assert.equal(runs, 1, '10분 전에는 멈춰 있다');
    later(1);
    await haltOnce();
    assert.equal(runs, 2, '10분 뒤 다시 가동해 일을 시작한다');
    assert.ok(notices.includes('엔진 자동 재가동'));

    later(10);
    engine.tick();
    assert.equal(runs, 2, '두 번째는 20분을 기다린다');
    later(10);
    await haltOnce();
    assert.equal(runs, 3);
  });

  it('auto_resume_minutes 가 0이면 사용자를 기다린다', async () => {
    const { board, root } = makeBoard();
    board.createTask('owner', { title: '목표', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null });
    const paths = resolvePaths({ BF_ROOT: root });
    let clock = new Date('2026-10-08T00:00:00Z');
    const config = { ...DEFAULT_CONFIG, claude_command: [process.execPath, FAKE], watchdog: { auto_resume_minutes: 0, stale_seconds: 120 } };
    const engine = new Engine(paths, config, {
      log: () => {},
      notify: () => {},
      now: () => clock,
      run: (spec) => runAgent(spec, { ...process.env, FAKE_PLAN: JSON.stringify({ ceo: 'auth' }) }),
    });
    await engine.runUntilIdle();
    clock = new Date(clock.getTime() + 24 * 3_600_000);
    engine.tick();
    assert.ok(engine.halted);
    assert.equal(engine.runningCount, 0);
  });

  it('engine-check 는 프로세스와 심장 박동으로 상태를 판단한다', () => {
    const root = makeRoot();
    const company = path.join(root, 'company');
    const check = () => {
      const out: string[] = [];
      const code = main(['engine-check'], { BF_ROOT: root }, { out: (s) => out.push(s), err: (s) => out.push(s) });
      return { code, out: out.join('\n') };
    };
    assert.equal(check().code, 1, '실행 중이 아니면 1');

    fs.mkdirSync(path.join(company, '.engine'), { recursive: true });
    fs.writeFileSync(path.join(company, '.engine', 'pid'), String(process.pid));
    const beat = (at: Date, halted: string | null = null) =>
      fs.writeFileSync(path.join(company, '.engine-heartbeat.json'), JSON.stringify({ pid: process.pid, at: at.toISOString(), enabled: true, halted }));
    assert.equal(check().code, 2, '박동이 없으면 멈춘 것');
    beat(new Date(Date.now() - 600_000));
    assert.equal(check().code, 2, '오래된 박동은 멈춘 것');
    beat(new Date());
    assert.match(check().out, /정상.*가동/);
    beat(new Date(), '인증 오류');
    const halted = check();
    assert.equal(halted.code, 0, '정지(halt)는 엔진 스스로 재가동한다');
    assert.match(halted.out, /정지 \(인증 오류\)/);
  });
});
