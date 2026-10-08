import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { listAgents } from '../src/agents.ts';
import { Board } from '../src/board.ts';
import { main } from '../src/cli.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { initCompany } from '../src/company.ts';
import { resolvePaths } from '../src/paths.ts';
import { buildAllowedTools } from '../src/runner.ts';
import { cronMatcher, dueSchedules } from '../src/schedule.ts';
import { makeRoot } from './helpers.ts';

function bf(root: string, args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { BF_ROOT: root, ...env }, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A goal that ceo is currently running, as the engine would leave it. */
function runningGoal(root: string, assignee = 'ceo') {
  const paths = resolvePaths({ BF_ROOT: root });
  const board = new Board(paths, DEFAULT_CONFIG);
  const t = board.createTask('owner', { title: '목표', assignee, doneWhen: ['x'], parent: null });
  board.start(t.id);
  return { board, paths, id: t.id };
}

const PROPOSAL = `---
name: web-dev
description: 웹사이트를 만드는 개발자
model: sonnet
tools: Read, Write, Edit, Bash
permissions: Bash(npm:*)
---
너는 웹 개발자다. 작업 공간에서 정적 웹사이트를 만들고, 빌드가 통과하는지 확인한 뒤 보고한다.
`;

describe('결재', () => {
  it('승인되면 요청한 권한이 그 업무에만 부여된다', () => {
    const root = makeRoot();
    const { board, id } = runningGoal(root);
    const ceo = { BF_ACTOR: 'ceo', BF_TASK: id };

    const req = bf(root, ['approval', 'request', id, '사이트 배포', '--need', 'Bash(npx vercel deploy:*)'], ceo);
    assert.equal(req.code, 0, req.err);
    assert.equal(board.read(id).task.status, 'blocked');
    assert.match(bf(root, ['inbox']).out, /결재 대기[\s\S]*사이트 배포[\s\S]*npx vercel deploy/);

    assert.equal(bf(root, ['task', 'answer', id, '응'], {}).code, 1, '결재는 answer 로 처리 불가');
    assert.equal(bf(root, ['approve', id], ceo).code, 1, '직원은 결재 불가');
    assert.equal(bf(root, ['approve', id, '--note', '이번만']).code, 0);

    const t = board.read(id).task;
    assert.equal(t.status, 'pending');
    assert.deepEqual(t.grants, ['Bash(npx vercel deploy:*)']);
    const agent = listAgents(resolvePaths({ BF_ROOT: root })).find((a) => a.name === 'ceo')!;
    assert.ok(buildAllowedTools(agent, { write: [], read: [] }, t.grants).includes('Bash(npx vercel deploy:*)'));
  });

  it('범위 없는 권한은 요청할 수 없다', () => {
    const root = makeRoot();
    const { id } = runningGoal(root);
    const r = bf(root, ['approval', 'request', id, '다 쓰게 해줘', '--need', 'Bash'], { BF_ACTOR: 'ceo', BF_TASK: id });
    assert.equal(r.code, 1);
    assert.match(r.err, /범위 제한이 없는/);
  });

  it('반려되면 사유와 함께 대기로 돌아간다', () => {
    const root = makeRoot();
    const { board, id } = runningGoal(root);
    bf(root, ['approval', 'request', id, '광고 집행 10만원'], { BF_ACTOR: 'ceo', BF_TASK: id });
    assert.equal(bf(root, ['deny', id, '아직 이르다']).code, 0);
    assert.equal(board.read(id).task.status, 'pending');
    assert.equal(board.read(id).task.grants?.length, 0);
    assert.match(board.readLog(id), /결재반려: 광고 집행 10만원 — 아직 이르다/);
  });
});

describe('채용', () => {
  it('채용안 제출 → 사용자 승인 → 직원 명부 등록', () => {
    const root = makeRoot();
    const { board, id, paths } = runningGoal(root, 'hr');
    const file = path.join(board.taskDir(id), 'output', 'web-dev.md');
    fs.writeFileSync(file, PROPOSAL);

    const r = bf(root, ['hire', 'propose', id, file], { BF_ACTOR: 'hr', BF_TASK: id });
    assert.equal(r.code, 0, r.err);
    assert.match(bf(root, ['hire', 'list']).out, /web-dev[\s\S]*Bash\(npm:\*\)/);
    assert.ok(!listAgents(paths).some((a) => a.name === 'web-dev'), '승인 전에는 직원이 아니다');

    assert.equal(bf(root, ['approve', id]).code, 0);
    assert.ok(listAgents(paths).some((a) => a.name === 'web-dev'));
    assert.equal(fs.existsSync(path.join(paths.hiring, 'web-dev.md')), false);
  });

  it('위험한 채용안은 제출 단계에서 거부된다', () => {
    const root = makeRoot();
    const { board, id } = runningGoal(root, 'hr');
    const file = path.join(board.taskDir(id), 'output', 'bad.md');
    const env = { BF_ACTOR: 'hr', BF_TASK: id };

    fs.writeFileSync(file, PROPOSAL.replace('Bash(npm:*)', 'Write'));
    assert.match(bf(root, ['hire', 'propose', id, file], env).err, /범위 제한이 없는/);

    fs.writeFileSync(file, PROPOSAL.replace('name: web-dev', 'name: worker'));
    assert.match(bf(root, ['hire', 'propose', id, file], env).err, /이미 있는 직원/);

    fs.writeFileSync(file, PROPOSAL.replace('name: web-dev', 'name: Web Dev!'));
    assert.match(bf(root, ['hire', 'propose', id, file], env).err, /직원 이름은/);
  });

  it('채용 반려 시 채용안은 폐기된다', () => {
    const root = makeRoot();
    const { board, id, paths } = runningGoal(root, 'hr');
    const file = path.join(board.taskDir(id), 'output', 'web-dev.md');
    fs.writeFileSync(file, PROPOSAL);
    bf(root, ['hire', 'propose', id, file], { BF_ACTOR: 'hr', BF_TASK: id });
    assert.equal(bf(root, ['deny', id, '권한이 과하다']).code, 0);
    assert.equal(fs.existsSync(path.join(paths.hiring, 'web-dev.md')), false);
    assert.ok(!listAgents(paths).some((a) => a.name === 'web-dev'));
  });
});

describe('회사 기억', () => {
  it('새 주제는 제목이 필요하고, 기록이 쌓이며 목차가 갱신된다', () => {
    const root = makeRoot();
    const env = { BF_ACTOR: 'worker', BF_TASK: 'T0003' };
    assert.match(bf(root, ['memory', 'add', 'deploy', '먼저 빌드'], env).err, /--title/);
    assert.equal(bf(root, ['memory', 'add', 'deploy', '먼저 빌드', '--title', '배포 요령'], env).code, 0);
    assert.equal(bf(root, ['memory', 'add', 'deploy', '환경변수 확인'], env).code, 0);

    assert.match(bf(root, ['memory', 'list']).out, /deploy\s+배포 요령 \(2건\)/);
    const shown = bf(root, ['memory', 'show', 'deploy']).out;
    assert.match(shown, /# 배포 요령[\s\S]*worker · T0003[\s\S]*먼저 빌드[\s\S]*환경변수 확인/);
    const index = fs.readFileSync(path.join(root, 'company', 'memory', 'index.md'), 'utf8');
    assert.match(index, /\[배포 요령\]\(deploy\.md\) — 2건/);
    assert.equal(bf(root, ['memory', 'show', '../secret']).code, 1);
  });
});

describe('받은 편지함', () => {
  it('끝난 목표를 보여주고 확인하면 사라진다', () => {
    const root = makeRoot();
    const { board, id } = runningGoal(root);
    board.done('ceo', id, '보고');
    board.pass('reviewer', id);
    assert.match(bf(root, ['inbox']).out, /끝난 목표[\s\S]*T0001/);
    assert.equal(bf(root, ['ack', id]).code, 0);
    assert.match(bf(root, ['inbox']).out, /처리할 일이 없습니다/);
  });
});

describe('정기 업무', () => {
  it('cron 표현식', () => {
    const at = (h: number, m: number, day = 8) => new Date(2026, 9, day, h, m); // 2026-10-08 목
    assert.ok(cronMatcher('0 9 * * *')(at(9, 0)));
    assert.ok(!cronMatcher('0 9 * * *')(at(9, 1)));
    assert.ok(cronMatcher('*/15 * * * *')(at(3, 45)));
    assert.ok(cronMatcher('0 9 * * 4')(at(9, 0)), '목요일');
    assert.ok(!cronMatcher('0 9 * * 1-5')(at(9, 0, 10)), '토요일');
    assert.ok(cronMatcher('30 8 1,15 * *')(at(8, 30, 15)));
    assert.throws(() => cronMatcher('0 25 * * *'));
  });

  it('시각이 지나면 한 번만 등록하고, 첫 실행 때 과거를 되풀이하지 않는다', () => {
    const root = makeRoot();
    const paths = resolvePaths({ BF_ROOT: root });
    fs.writeFileSync(
      path.join(paths.company, 'schedules.yaml'),
      'schedules:\n  - id: daily\n    cron: "0 9 * * *"\n    goal: 일일 점검\n',
    );
    assert.equal(dueSchedules(paths, new Date(2026, 9, 8, 8, 59)).length, 0, '첫 실행');
    assert.deepEqual(dueSchedules(paths, new Date(2026, 9, 8, 9, 0, 30)).map((s) => s.id), ['daily']);
    assert.equal(dueSchedules(paths, new Date(2026, 9, 8, 9, 5)).length, 0, '중복 없음');
  });
});

describe('회사 설립', () => {
  it('견본에서 핸드북과 기본 직원을 가져온다', () => {
    const root = makeRoot();
    fs.rmSync(path.join(root, 'company'), { recursive: true });
    const realTemplates = path.resolve(import.meta.dirname, '..', '..', 'templates');
    fs.cpSync(realTemplates, path.join(root, 'templates'), { recursive: true });
    const paths = resolvePaths({ BF_ROOT: root });
    initCompany(paths, { git: false });
    assert.deepEqual(listAgents(paths).map((a) => a.name), ['ceo', 'hr', 'reviewer', 'worker']);
    assert.match(fs.readFileSync(paths.handbook, 'utf8'), /# 직원 핸드북/);
    const ceo = listAgents(paths).find((a) => a.name === 'ceo')!;
    assert.equal(ceo.model, 'opus');
    assert.ok(ceo.prompt.includes('CEO'));
  });
});
