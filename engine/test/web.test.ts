import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Board } from '../src/board.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { resolvePaths } from '../src/paths.ts';
import { lastLogEntry, startWeb } from '../src/web.ts';
import { setPassword } from '../src/webauth.ts';
import { makeRoot } from './helpers.ts';

const PORT = 43000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

describe('웹 화면', () => {
  let server: http.Server;
  let board: Board;
  let token = '';

  before(async () => {
    const root = makeRoot();
    const paths = resolvePaths({ BF_ROOT: root });
    board = new Board(paths, DEFAULT_CONFIG);
    server = startWeb(paths, DEFAULT_CONFIG, { port: PORT, log: () => {} });
    await new Promise((r) => server.once('listening', r));
    const html = await (await fetch(BASE)).text();
    token = /const TOKEN = '([0-9a-f]+)'/.exec(html)?.[1] ?? '';
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  const post = (p: string, body: object, tok = token) =>
    fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BF-Token': tok }, body: JSON.stringify(body) });

  it('페이지에 요청 토큰이 들어 있다', () => {
    assert.match(token, /^[0-9a-f]{48}$/);
  });

  it('토큰 없는 쓰기 요청은 거부한다', async () => {
    const r = await post('/api/goal', { text: '몰래' }, 'wrong');
    assert.equal(r.status, 403);
    assert.equal(board.list().length, 0);
  });

  it('로컬이 아닌 Host 헤더는 거부한다 (DNS 리바인딩 차단)', async () => {
    const http = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { Host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    assert.equal(status, 403);
  });

  it('목표 등록 → 현황에 나타난다', async () => {
    const r = await post('/api/goal', { text: '웹에서 등록한 목표\n상세 설명', project: 'alpha' });
    assert.equal(r.status, 200);
    const { id } = await r.json();
    const state = await (await fetch(BASE + '/api/state')).json();
    const t = state.tasks.find((x: { id: string }) => x.id === id);
    assert.equal(t.title, '웹에서 등록한 목표');
    assert.equal(t.project, 'alpha');
    assert.equal(t.assignee, 'ceo');
  });

  it('질문과 결재가 처리할 일에 나오고, 웹에서 답하고 승인할 수 있다', async () => {
    const q = board.createTask('owner', { title: '질문 목표', assignee: 'ceo', doneWhen: ['x'], parent: null });
    board.start(q.id);
    board.ask('ceo', q.id, '콘솔 가입 부탁드립니다\n1. 접속\n2. 가입');
    const a = board.createTask('owner', { title: '결재 목표', assignee: 'ceo', doneWhen: ['x'], parent: null });
    board.start(a.id);
    board.requestApproval('ceo', a.id, '도메인 구매', ['Bash(npx vercel deploy:*)']);

    const state = await (await fetch(BASE + '/api/state')).json();
    assert.equal(state.inbox.questions[0].question, '콘솔 가입 부탁드립니다\n1. 접속\n2. 가입');
    assert.deepEqual(state.inbox.approvals[0].grants, ['Bash(npx vercel deploy:*)']);
    assert.equal(state.tasks.find((t: { id: string }) => t.id === a.id).label, '결재대기');

    assert.equal((await post(`/api/task/${q.id}/answer`, { text: '가입 완료' })).status, 200);
    assert.equal((await post(`/api/task/${a.id}/approve`, { note: '' })).status, 200);
    assert.equal(board.read(q.id).task.status, 'pending');
    assert.deepEqual(board.read(a.id).task.grants, ['Bash(npx vercel deploy:*)']);
  });

  it('처리할 일에 코멘트를 달면 스레드에 쌓이고, 업무는 그대로 기다린다', async () => {
    const q = board.createTask('owner', { title: '코멘트 목표', assignee: 'ceo', doneWhen: ['x'], parent: null });
    board.start(q.id);
    board.ask('ceo', q.id, '이름을 정해 주세요');
    assert.equal((await post(`/api/task/${q.id}/thread`, { text: '후보를 보여 주세요' })).status, 200);
    assert.equal((await post(`/api/task/${q.id}/thread`, { text: '짧은 이름이면 좋겠어요' })).status, 200);
    const state = await (await fetch(BASE + '/api/state')).json();
    const card = state.inbox.questions.find((x: { id: string }) => x.id === q.id);
    assert.deepEqual(card.thread.map((e: { text: string }) => e.text), ['후보를 보여 주세요', '짧은 이름이면 좋겠어요']);
    assert.equal(state.owner, 'owner');
    assert.equal(board.read(q.id).task.status, 'blocked');
    assert.equal((await post(`/api/task/${q.id}/thread`, { text: ' ' })).status, 400);
  });

  it('업무 상세는 하위 업무 전체와 그 이력을 함께 준다', async () => {
    const g = board.createTask('owner', { title: '트리 목표', assignee: 'ceo', doneWhen: ['x'], parent: null });
    board.start(g.id);
    const c = board.createTask('ceo', { title: '하위', assignee: 'worker', doneWhen: ['x'], parent: g.id });
    board.start(c.id);
    const gc = board.createTask('worker', { title: '손자', assignee: 'owner', doneWhen: ['x'], parent: c.id });
    const d = await (await fetch(`${BASE}/api/task/${g.id}`)).json();
    assert.deepEqual(d.tree.map((t: { id: string; depth: number }) => [t.id, t.depth]), [[c.id, 1], [gc.id, 2]]);
    assert.match(d.tree[1].log, /생성: 담당: owner/);
    const state = await (await fetch(BASE + '/api/state')).json();
    assert.ok(state.inbox.mine.some((m: { id: string; assignee: string }) => m.id === gc.id && m.assignee === 'worker'));
    assert.equal((await post(`/api/task/${gc.id}/finish`, { text: '했습니다' })).status, 200);
    assert.equal(board.read(gc.id).task.status, 'done');
  });

  it('규칙 위반은 이유와 함께 400', async () => {
    const r = await post('/api/task/T0001/deny', { reason: '' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /결재 대기 중이 아닙니다|사유/);
  });

  it('업무 상세와 결과물 보기, 결과물 폴더 밖은 막는다', async () => {
    const id = board.list()[0].id;
    fs.writeFileSync(path.join(board.taskDir(id), 'output', 'report.md'), '# 보고서');
    const d = await (await fetch(`${BASE}/api/task/${id}`)).json();
    assert.deepEqual(d.outputs.map((o: { path: string }) => o.path), ['report.md']);
    const f = await (await fetch(`${BASE}/api/task/${id}/file?path=report.md`)).json();
    assert.equal(f.text, '# 보고서');
    const bad = await fetch(`${BASE}/api/task/${id}/file?path=${encodeURIComponent('../task.md')}`);
    assert.equal(bad.status, 400);
  });

  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = (body: Buffer, tok = token) =>
    fetch(`${BASE}/api/upload`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-BF-Token': tok }, body: new Uint8Array(body) });

  it('이미지를 올리면 보드 첨부 폴더에 저장되고, 직원이 읽을 경로를 돌려준다', async () => {
    assert.equal((await upload(PNG, 'wrong')).status, 403);
    const r = await upload(PNG);
    assert.equal(r.status, 200);
    const { path: file } = await r.json();
    assert.match(file, /[\\/]board[\\/]attachments[\\/][\w-]+\.png$/);
    assert.deepEqual(fs.readFileSync(file), PNG);

    const img = await fetch(`${BASE}/api/attachment?path=${encodeURIComponent(file)}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  });

  it('이미지가 아니거나 첨부 폴더 밖의 파일은 거부한다', async () => {
    const fake = await upload(Buffer.from('<svg onload="alert(1)"/>'));
    assert.equal(fake.status, 400);
    assert.match((await fake.json()).error, /PNG, JPG/);
    const id = board.list()[0].id;
    const outside = await fetch(`${BASE}/api/attachment?path=${encodeURIComponent(path.join(board.taskDir(id), 'task.md'))}`);
    assert.equal(outside.status, 400);
  });

  it('결과물 이미지는 그림 그대로 보여 준다', async () => {
    const id = board.list()[0].id;
    fs.writeFileSync(path.join(board.taskDir(id), 'output', 'chart.png'), PNG);
    const r = await fetch(`${BASE}/api/task/${id}/file?raw=1&path=chart.png`);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
    const text = await fetch(`${BASE}/api/task/${id}/file?raw=1&path=report.md`);
    assert.equal(text.status, 400);
  });
});

describe('웹 화면 로그인', () => {
  const port = PORT + 1000;
  const base = `http://127.0.0.1:${port}`;
  let server: http.Server;

  before(async () => {
    const paths = resolvePaths({ BF_ROOT: makeRoot() });
    setPassword(paths, 'correct horse');
    const config = { ...DEFAULT_CONFIG, web: { ...DEFAULT_CONFIG.web, allowed_hosts: ['bf.example.ts.net'] } };
    server = startWeb(paths, config, { port, log: () => {} });
    await new Promise((r) => server.once('listening', r));
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  const login = (password: string) =>
    fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password }),
    });

  it('암호가 있으면 로그인 전에는 페이지와 API를 막는다', async () => {
    const page = await fetch(base, { redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/login');
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/login`)).status, 200);
  });

  it('틀린 암호는 거부하고, 맞는 암호면 세션 쿠키로 들어간다', async () => {
    assert.equal((await login('wrong password')).status, 401);
    const ok = await login('correct horse');
    assert.equal(ok.status, 303);
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /^bf_session=[0-9a-f]{64}$/);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: 'bf_session=forged' } })).status, 401);
  });

  it('allowed_hosts에 넣은 이름은 Host 헤더로 받는다', async () => {
    const http = await import('node:http');
    const status = (host: string) =>
      new Promise<number>((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/login', headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
      });
    assert.equal(await status('bf.example.ts.net'), 200);
    assert.equal(await status('evil.example'), 403);
  });
});

describe('이력 읽기', () => {
  it('여러 줄짜리 마지막 항목을 통째로 꺼낸다', () => {
    const log = [
      '- 2026-10-08T00:00:00.000Z [ceo] 질문: → owner: 첫 질문',
      '- 2026-10-08T00:01:00.000Z [owner] 답변: 응',
      '- 2026-10-08T00:02:00.000Z [ceo] 질문: → owner: 둘째 질문',
      '  1. 가입',
      '  2. 문의',
      '- 2026-10-08T00:03:00.000Z [engine] 코멘트: 끝',
    ].join('\n');
    assert.equal(lastLogEntry(log, '질문'), '둘째 질문\n1. 가입\n2. 문의');
  });
});
