import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { BoardError, normalizeId } from '../src/board.ts';
import type { Board } from '../src/board.ts';
import { DONE_WHEN, makeBoard } from './helpers.ts';

function goal(board: Board, title = '목표') {
  return board.createTask('owner', { title, assignee: 'ceo', doneWhen: DONE_WHEN, parent: null, review: false });
}

function sub(board: Board, parent: string, actor: string, assignee = 'worker', extra = {}) {
  return board.createTask(actor, { title: '하위', assignee, doneWhen: DONE_WHEN, parent, ...extra });
}

describe('업무 생성 규칙', () => {
  it('완료 조건이 없으면 거부한다', () => {
    const { board } = makeBoard();
    assert.throws(
      () => board.createTask('owner', { title: 'x', assignee: 'ceo', doneWhen: ['  '], parent: null }),
      /완료 조건/,
    );
  });

  it('존재하지 않는 직원에게 배정할 수 없다', () => {
    const { board } = makeBoard();
    assert.throws(
      () => board.createTask('owner', { title: 'x', assignee: 'ghost', doneWhen: DONE_WHEN, parent: null }),
      /존재하지 않는 직원/,
    );
  });

  it('최상위 목표는 사용자만 만들 수 있고 항상 검수한다', () => {
    const { board } = makeBoard();
    assert.throws(
      () => board.createTask('ceo', { title: 'x', assignee: 'worker', doneWhen: DONE_WHEN, parent: null }),
      /하위 업무만/,
    );
    assert.equal(goal(board).review, true);
  });

  it('상위 업무의 담당자만 하위 업무를 만들 수 있다', () => {
    const { board } = makeBoard();
    const g = goal(board);
    assert.throws(() => sub(board, g.id, 'hr'), /담당자가 아니므로/);
    const child = sub(board, g.id, 'ceo');
    assert.equal(child.parent, g.id);
    assert.equal(child.depth, 1);
    assert.equal(child.created_by, 'ceo');
  });

  it('위임 깊이 한도를 넘을 수 없다', () => {
    const { board } = makeBoard({ max_depth: 2 });
    const g = goal(board);
    const d1 = sub(board, g.id, 'ceo', 'hr');
    const d2 = sub(board, d1.id, 'hr', 'worker');
    assert.throws(() => sub(board, d2.id, 'worker', 'reviewer'), /위임 깊이 한도/);
  });

  it('작업 공간·프로젝트·우선순위를 상위에서 물려받는다', () => {
    const { board } = makeBoard();
    const g = board.createTask('owner', {
      title: 'g', assignee: 'ceo', doneWhen: DONE_WHEN, parent: null,
      workspace: 'app-a', project: 'alpha', priority: 5,
    });
    const child = sub(board, g.id, 'ceo');
    assert.equal(child.workspace, 'app-a');
    assert.equal(child.project, 'alpha');
    assert.equal(child.priority, 5);
  });

  it('번호는 겹치지 않고 업무 폴더와 output 폴더가 만들어진다', () => {
    const { board } = makeBoard();
    const a = goal(board);
    const b = goal(board);
    assert.deepEqual([a.id, b.id], ['T0001', 'T0002']);
    assert.ok(fs.existsSync(path.join(board.taskDir(a.id), 'output')));
    assert.match(board.read(a.id).body, /## 완료 조건\n\n- 결과물이 output/);
  });
});

describe('업무 흐름', () => {
  it('목표 → 위임 → 하위 대기 → 하위 완료 → 상위 재개 → 검수 → 완료', () => {
    const { board } = makeBoard();
    const g = goal(board);
    board.start(g.id);
    const c1 = sub(board, g.id, 'ceo');
    const c2 = sub(board, g.id, 'ceo', 'worker', { review: false });

    // CEO 실행이 하위 업무만 남기고 끝남
    assert.equal(board.finishRun(g.id, 'run ended').status, 'waiting');

    board.start(c1.id);
    assert.equal(board.done('worker', c1.id, '했음').status, 'review');
    assert.equal(board.pass('reviewer', c1.id).status, 'done');
    assert.equal(board.read(g.id).task.status, 'waiting', '아직 c2가 남음');

    board.start(c2.id);
    assert.equal(board.done('worker', c2.id, '했음').status, 'done', '검수 없는 업무는 바로 완료');
    assert.equal(board.read(g.id).task.status, 'pending', '하위가 모두 끝나 상위 재개');

    board.start(g.id);
    assert.equal(board.done('ceo', g.id, '보고서 작성').status, 'review');
    assert.equal(board.pass('reviewer', g.id).status, 'done');
    assert.match(board.readLog(g.id), /\[system\] 재개/);
  });

  it('하위 업무가 진행 중이면 완료 보고를 거부한다', () => {
    const { board } = makeBoard();
    const g = goal(board);
    board.start(g.id);
    sub(board, g.id, 'ceo');
    assert.throws(() => board.done('ceo', g.id, '끝'), /진행 중인 하위 업무/);
  });

  it('남의 업무는 완료하거나 질문할 수 없다', () => {
    const { board } = makeBoard();
    const g = goal(board);
    board.start(g.id);
    assert.throws(() => board.done('worker', g.id, '끝'), /담당자는 ceo/);
    assert.throws(() => board.ask('worker', g.id, '?'), /담당자는 ceo/);
  });

  it('질문은 지시자에게 가고 지시자나 사용자만 답할 수 있다', () => {
    const { board } = makeBoard();
    const g = goal(board);
    board.start(g.id);
    const c = sub(board, g.id, 'ceo');
    board.start(c.id);
    const asked = board.ask('worker', c.id, '어떤 형식으로?');
    assert.equal(asked.status, 'blocked');
    assert.equal(asked.ask_to, 'ceo');
    assert.throws(() => board.answer('hr', c.id, '몰라'), /ceo 에게 온 것/);
    const answered = board.answer('ceo', c.id, '마크다운');
    assert.equal(answered.status, 'pending');
    assert.equal(answered.ask_to, null);
    assert.match(board.readLog(c.id), /답변: 마크다운/);
  });

  it('반려되면 대기로 돌아가고, 반려 한도를 넘으면 실패 처리 후 상위를 깨운다', () => {
    const { board } = makeBoard({ max_rejections: 2 });
    const g = goal(board);
    board.start(g.id);
    const c = sub(board, g.id, 'ceo');
    board.finishRun(g.id, 'delegated');

    board.start(c.id);
    board.done('worker', c.id, '1차');
    assert.equal(board.reject('reviewer', c.id, '표 누락').status, 'pending');

    board.start(c.id);
    board.done('worker', c.id, '2차');
    assert.equal(board.reject('reviewer', c.id, '여전히 누락').status, 'failed');
    assert.equal(board.read(g.id).task.status, 'pending');
  });

  it('검수 권한과 자기 검수 금지', () => {
    const { board } = makeBoard();
    const g = goal(board);
    board.start(g.id);
    const c = sub(board, g.id, 'ceo', 'reviewer');
    board.start(c.id);
    board.done('reviewer', c.id, '했음');
    assert.throws(() => board.pass('hr', c.id), /검수 판정은/);
    assert.throws(() => board.pass('reviewer', c.id), /자기 업무는/);
    assert.equal(board.pass('ceo', c.id).status, 'done', '지시자는 검수 가능');
  });

  it('보고 없이 끝난 실행은 재시도하고, 시도 한도를 넘으면 실패한다', () => {
    const { board } = makeBoard({ max_attempts: 2 });
    const g = goal(board);
    board.start(g.id);
    assert.equal(board.finishRun(g.id, '보고 없음').status, 'pending');
    board.start(g.id);
    assert.equal(board.finishRun(g.id, '보고 없음').status, 'failed');
  });

  it('사용량 한도로 되돌린 실행은 시도 횟수를 쓰지 않는다', () => {
    const { board } = makeBoard();
    const g = goal(board);
    board.start(g.id);
    const t = board.requeue(g.id, '사용량 한도');
    assert.equal(t.status, 'pending');
    assert.equal(t.attempts, 0);
  });

  it('취소는 하위 업무까지 전파된다', () => {
    const { board } = makeBoard();
    const g = goal(board);
    board.start(g.id);
    const c = sub(board, g.id, 'ceo', 'hr');
    board.start(c.id);
    const gc = sub(board, c.id, 'hr');
    assert.throws(() => board.cancel('worker', g.id), /지시자 또는 사용자만/);
    board.cancel('owner', g.id, '방향 전환');
    for (const id of [g.id, c.id, gc.id]) assert.equal(board.read(id).task.status, 'canceled');
  });

  it('허용되지 않는 상태 전환은 거부한다', () => {
    const { board } = makeBoard();
    const g = goal(board);
    assert.throws(() => board.done('ceo', g.id, '끝'), /대기 상태입니다/);
    assert.throws(() => board.pass('owner', g.id), BoardError);
  });
});

describe('실행 후보 선정', () => {
  it('선행 업무가 끝나야 실행 가능하고, 우선순위가 높은 것부터', () => {
    const { board } = makeBoard();
    const g = goal(board);
    board.start(g.id);
    const a = sub(board, g.id, 'ceo', 'worker', { review: false });
    const b = sub(board, g.id, 'ceo', 'worker', { dependsOn: [a.id] });
    const urgent = sub(board, g.id, 'ceo', 'worker', { priority: 9 });
    assert.deepEqual(board.runnable().map((t) => t.id), [urgent.id, a.id]);
    board.start(a.id);
    board.done('worker', a.id, 'ok');
    assert.ok(board.runnable().some((t) => t.id === b.id));
  });
});

describe('normalizeId', () => {
  it('여러 표기를 받아들인다', () => {
    assert.equal(normalizeId('12'), 'T0012');
    assert.equal(normalizeId('t7'), 'T0007');
    assert.equal(normalizeId('T0003'), 'T0003');
    assert.throws(() => normalizeId('abc'), /잘못된 업무 번호/);
  });
});

describe('동시성', () => {
  it('여러 프로세스가 동시에 업무를 만들어도 번호가 겹치지 않는다', async () => {
    const { root } = makeBoard();
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const N = 8;
    const runs = Array.from({ length: N }, (_, i) =>
      new Promise<number>((resolve) => {
        const p = spawn(process.execPath, [cli, 'goal', `동시 목표 ${i}`], {
          env: { ...process.env, BF_ROOT: root, BF_ACTOR: 'owner' },
          stdio: 'ignore',
        });
        p.on('exit', (code) => resolve(code ?? 1));
      }),
    );
    assert.deepEqual(await Promise.all(runs), Array(N).fill(0));
    const ids = fs.readdirSync(path.join(root, 'company', 'board')).filter((n) => /^T\d+$/.test(n));
    assert.equal(new Set(ids).size, N);
  });
});
