import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BoardError } from '../src/board.ts';
import type { Task } from '../src/board.ts';
import { ensureWorktree, integrateWorktree, removeWorktree } from '../src/worktree.ts';
import { makeBoard } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A workspace repo on branch main, with an ignored node_modules and .env like a real project. */
function gitWorkspace(workspaces: string, name = 'app'): string {
  const dir = path.join(workspaces, name);
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, 'shared.txt'), '원본\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('업무별 worktree', () => {
  function setup() {
    const { board } = makeBoard();
    const paths = board.paths;
    const main = gitWorkspace(paths.workspaces);
    const task = (title: string) => {
      const t = board.createTask('owner', { title, assignee: 'worker', doneWhen: ['x'], parent: null, workspace: 'app' });
      const wt = ensureWorktree(paths, t)!;
      return board.setWorktree(t.id, wt);
    };
    return { board, paths, main, task };
  }

  it('업무마다 기준 브랜치에서 갈라진 worktree 를 만들고, git 제외 파일은 링크로 공유한다', () => {
    const { main, task, paths } = setup();
    const t = task('a');
    assert.equal(t.worktree!.branch, 'bf/T0001');
    assert.equal(t.worktree!.base, 'main');
    assert.equal(git(t.worktree!.path, 'branch', '--show-current'), 'bf/T0001');
    assert.ok(fs.existsSync(path.join(t.worktree!.path, 'node_modules', 'pkg')));
    assert.equal(fs.readFileSync(path.join(t.worktree!.path, '.env'), 'utf8'), 'SECRET=1');
    assert.equal(git(t.worktree!.path, 'status', '--porcelain'), '', '링크는 커밋 대상이 아니다');
    assert.equal(git(main, 'status', '--porcelain'), '');
  });

  it('완료 보고 때 남은 변경을 커밋하고, 먼저 끝난 업무의 변경과 합쳐 기준 브랜치에 반영한다', () => {
    const { main, task, paths } = setup();
    const a = task('a'), b = task('b');
    fs.writeFileSync(path.join(a.worktree!.path, 'a.txt'), 'A');
    fs.writeFileSync(path.join(b.worktree!.path, 'b.txt'), 'B');
    assert.match(integrateWorktree(paths, a)!, /bf\/T0001 → main/);
    assert.ok(fs.existsSync(path.join(main, 'a.txt')), '체크아웃된 기준 브랜치의 파일도 바뀐다');
    integrateWorktree(paths, b);
    assert.ok(fs.existsSync(path.join(main, 'b.txt')));
    assert.ok(fs.existsSync(path.join(main, 'a.txt')));
    assert.equal(git(main, 'status', '--porcelain'), '');
  });

  it('같은 곳을 고쳐 충돌하면 완료 보고를 거부하고, 해결 후 다시 보고하면 반영된다', () => {
    const { main, task, paths } = setup();
    const a = task('a'), b = task('b');
    fs.writeFileSync(path.join(a.worktree!.path, 'shared.txt'), 'A의 수정\n');
    fs.writeFileSync(path.join(b.worktree!.path, 'shared.txt'), 'B의 수정\n');
    integrateWorktree(paths, a);
    assert.throws(() => integrateWorktree(paths, b), (e: Error) => e instanceof BoardError && /충돌.*shared\.txt/s.test(e.message));
    assert.throws(() => integrateWorktree(paths, b), /병합이 끝나지 않았습니다/);
    fs.writeFileSync(path.join(b.worktree!.path, 'shared.txt'), 'A의 수정\nB의 수정\n');
    git(b.worktree!.path, 'add', '-A');
    git(b.worktree!.path, 'commit', '-q', '--no-edit');
    integrateWorktree(paths, b);
    assert.equal(fs.readFileSync(path.join(main, 'shared.txt'), 'utf8'), 'A의 수정\nB의 수정\n');
  });

  it('끝난 업무의 worktree 는 지우고, 반영된 브랜치만 지운다', () => {
    const { main, task, paths } = setup();
    const a = task('a'), b = task('b');
    fs.writeFileSync(path.join(a.worktree!.path, 'a.txt'), 'A');
    fs.writeFileSync(path.join(b.worktree!.path, 'b.txt'), 'B');
    git(b.worktree!.path, 'add', '-A');
    git(b.worktree!.path, 'commit', '-q', '-m', 'b');
    integrateWorktree(paths, a);
    removeWorktree(paths, { ...a, status: 'done' } as Task);
    removeWorktree(paths, { ...b, status: 'failed' } as Task);
    assert.ok(!fs.existsSync(a.worktree!.path));
    assert.ok(!fs.existsSync(b.worktree!.path));
    const branches = git(main, 'branch', '--format=%(refname:short)').split('\n');
    assert.ok(!branches.includes('bf/T0001'), '반영된 브랜치는 지운다');
    assert.ok(branches.includes('bf/T0002'), '실패한 업무의 작업은 브랜치로 남긴다');
  });
});
