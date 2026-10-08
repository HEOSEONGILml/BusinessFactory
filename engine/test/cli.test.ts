import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import { makeRoot } from './helpers.ts';

function bf(root: string, args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { BF_ROOT: root, ...env }, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('bf 명령어', () => {
  it('init 은 회사 폴더를 만들고 다시 실행해도 덮어쓰지 않는다', () => {
    const root = makeRoot();
    assert.equal(bf(root, ['init', '--no-git']).code, 0);
    const handbook = path.join(root, 'company', 'handbook.md');
    fs.writeFileSync(handbook, '수정됨');
    bf(root, ['init', '--no-git']);
    assert.equal(fs.readFileSync(handbook, 'utf8'), '수정됨');
    assert.ok(fs.existsSync(path.join(root, 'workspaces')));
  });

  it('사용자 목표 → 직원의 하위 업무 → 완료 보고까지', () => {
    const root = makeRoot();
    assert.match(bf(root, ['goal', '시장 조사']).out, /목표 등록: T0001 → ceo/);

    // 직원은 수행 중인 업무(BF_TASK) 안에서만 업무를 만든다
    const ceo = { BF_ACTOR: 'ceo', BF_TASK: '1' };
    const created = bf(root, ['task', 'create', '--to', 'worker', '--title', '자료 수집', '--done-when', '5건 이상'], ceo);
    assert.equal(created.code, 0, created.err);
    assert.match(created.out, /T0002 → worker \(상위 T0001\)/);

    const noTask = bf(root, ['task', 'create', '--to', 'worker', '--title', 'x', '--done-when', 'y'], { BF_ACTOR: 'ceo' });
    assert.equal(noTask.code, 1);
    assert.match(noTask.err, /하위 업무만/);

    const shown = bf(root, ['task', 'show', 'T0001']);
    assert.match(shown.out, /하위 업무:\n  T0002/);
    assert.match(shown.out, /## 이력/);

    assert.match(bf(root, ['task', 'list']).out, /T0002/);
    assert.match(bf(root, ['status']).out, /업무 2건: 대기 2/);
  });

  it('규칙 위반은 종료 코드 1과 이유를 돌려준다', () => {
    const root = makeRoot();
    bf(root, ['goal', '목표']);
    const r = bf(root, ['task', 'create', '--to', 'worker', '--title', 'x'], { BF_ACTOR: 'ceo', BF_TASK: 'T0001' });
    assert.equal(r.code, 1);
    assert.match(r.err, /완료 조건/);

    const wrongActor = bf(root, ['goal', '몰래'], { BF_ACTOR: 'ceo' });
    assert.equal(wrongActor.code, 1);
    assert.match(wrongActor.err, /사용자만/);
  });

  it('알 수 없는 옵션은 종료 코드 2', () => {
    const root = makeRoot();
    assert.equal(bf(root, ['task', 'list', '--bogus']).code, 2);
  });
});
