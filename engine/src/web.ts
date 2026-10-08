import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgents } from './agents.ts';
import { Board, BoardError, DEFAULT_GOAL_DONE_WHEN, isTerminal, normalizeId, STATUS_LABEL } from './board.ts';
import type { Task } from './board.ts';
import type { Config } from './config.ts';
import { listMemory } from './memory.ts';
import type { Paths } from './paths.ts';
import { discardHires, installHires, pendingProposals } from './staff.ts';
import { readUsage } from './usage.ts';
import { lastActivity, readUsageSnapshot } from './watch.ts';

/** What the page shows about the engine itself. */
export interface EngineStatus {
  running: boolean;
  pausedUntil: string | null;
  halted: string | null;
}

export interface WebOptions {
  port: number;
  /** Live engine status when the server runs inside the engine; otherwise read from the pid file. */
  engineStatus?: () => EngineStatus;
  log?: (line: string) => void;
}

const PAGE = fileURLToPath(new URL('../web/index.html', import.meta.url));
const MAX_FILE = 1_000_000;

export function statusLabel(t: Task): string {
  return t.status === 'blocked' && t.approval ? '결재대기' : STATUS_LABEL[t.status];
}

/** The full text of the newest log entry of one kind (entries can span several lines). */
export function lastLogEntry(log: string, event: string): string {
  const entries = log.split(/\n(?=- \S+ \[)/);
  const hit = entries.reverse().find((e) => new RegExp(`^- \\S+ \\[[^\\]]+\\] ${event}:`).test(e));
  if (!hit) return '';
  return hit
    .replace(new RegExp(`^- \\S+ \\[[^\\]]+\\] ${event}: (→ \\S+: )?`), '')
    .split('\n')
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n')
    .trim();
}

function pidEngineStatus(paths: Paths): EngineStatus {
  const pidFile = path.join(paths.company, '.engine', 'pid');
  let running = false;
  if (fs.existsSync(pidFile)) {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0);
      running = true;
    } catch {
      running = false;
    }
  }
  return { running, pausedUntil: null, halted: null };
}

export function buildState(board: Board, paths: Paths, engine: EngineStatus) {
  const tasks = board.list();
  const owner = board.config.owner;
  const proposals = new Map(pendingProposals(paths).map((p) => [p.name, p]));

  const approvals = tasks
    .filter((t) => t.status === 'blocked' && t.approval)
    .map((t) => ({
      id: t.id,
      assignee: t.assignee,
      title: t.title,
      what: t.approval!.what,
      grants: t.approval!.grants,
      hires: t.approval!.hires.map((name) => {
        const p = proposals.get(name);
        return {
          name,
          description: p?.description ?? '',
          model: p?.model ?? null,
          tools: p?.tools ?? [],
          permissions: p?.permissions ?? [],
          body: p ? fs.readFileSync(p.file, 'utf8') : '(채용안 파일 없음)',
        };
      }),
    }));
  const questions = tasks
    .filter((t) => t.status === 'blocked' && !t.approval && t.ask_to === owner)
    .map((t) => ({ id: t.id, assignee: t.assignee, title: t.title, question: lastLogEntry(board.readLog(t.id), '질문') }));
  const finished = tasks
    .filter((t) => t.parent === null && isTerminal(t.status) && !t.acknowledged && t.status !== 'canceled')
    .map((t) => ({ id: t.id, title: t.title, status: t.status, label: statusLabel(t) }));

  const since = Date.now() - 7 * 86_400_000;
  const runs = readUsage(paths).filter((e) => Date.parse(e.at) >= since);
  const byAgent: Record<string, number> = {};
  for (const r of runs) byAgent[r.agent] = (byAgent[r.agent] ?? 0) + 1;

  return {
    company: path.basename(path.dirname(paths.company)),
    engine,
    usage: readUsageSnapshot(paths),
    runs: { total: runs.length, byAgent },
    inbox: { approvals, questions, finished },
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      label: statusLabel(t),
      assignee: t.assignee,
      parent: t.parent,
      project: t.project,
      workspace: t.workspace,
      priority: t.priority,
      acknowledged: !!t.acknowledged,
      created_at: t.created_at,
      updated_at: t.updated_at,
      activity: t.status === 'running' ? lastActivity(board.taskDir(t.id)) : null,
    })),
    agents: listAgents(paths).map((a) => ({ name: a.name, model: a.model, description: a.description })),
    workspaces: fs.existsSync(paths.workspaces)
      ? fs.readdirSync(paths.workspaces, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : [],
    memory: listMemory(paths).map((m) => ({ topic: m.topic, title: m.title, entries: m.entries })),
  };
}

function taskDetail(board: Board, id: string) {
  const { task, body } = board.read(id);
  const dir = board.taskDir(id);
  const outDir = path.join(dir, 'output');
  const outputs = fs.existsSync(outDir)
    ? fs.readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => {
          const full = path.join(d.parentPath, d.name);
          return { path: path.relative(outDir, full).split(path.sep).join('/'), size: fs.statSync(full).size };
        })
    : [];
  const activityFile = path.join(dir, 'activity.log');
  const activity = fs.existsSync(activityFile) ? fs.readFileSync(activityFile, 'utf8').trimEnd().split('\n').slice(-80) : [];
  return {
    task: { ...task, label: statusLabel(task) },
    body,
    log: board.readLog(id),
    activity,
    outputs,
    children: board.children(id).map((c) => ({ id: c.id, title: c.title, status: c.status, label: statusLabel(c), assignee: c.assignee })),
  };
}

function readOutput(board: Board, id: string, rel: string): string {
  const outDir = path.resolve(board.taskDir(id), 'output');
  const full = path.resolve(outDir, rel);
  if (!full.startsWith(outDir + path.sep)) throw new BoardError('결과물 폴더 밖의 파일은 볼 수 없습니다.');
  if (!fs.existsSync(full)) throw new BoardError('파일이 없습니다.');
  if (fs.statSync(full).size > MAX_FILE) throw new BoardError('파일이 너무 커서 화면에 표시할 수 없습니다.');
  return fs.readFileSync(full, 'utf8');
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new BoardError('요청이 너무 큽니다.');
  }
  return raw ? JSON.parse(raw) : {};
}

/**
 * Local web console. Binds to 127.0.0.1 only; every write needs the per-process token
 * embedded in the page, and the Host header must be local (blocks DNS rebinding).
 */
export function startWeb(paths: Paths, config: Config, opts: WebOptions): http.Server {
  const board = new Board(paths, config);
  const owner = config.owner;
  const token = randomBytes(24).toString('hex');
  const log = opts.log ?? ((l: string) => console.log(l));
  const engineStatus = opts.engineStatus ?? (() => pidEngineStatus(paths));
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);

  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const actions: Record<string, (id: string, b: Record<string, any>) => unknown> = {
    approve: (id, b) => board.approve(owner, id, String(b.note ?? ''), (names) => installHires(paths, names)),
    deny: (id, b) => board.deny(owner, id, String(b.reason ?? ''), (names) => discardHires(paths, names)),
    answer: (id, b) => board.answer(owner, id, String(b.text ?? '')),
    ack: (id) => board.acknowledge(owner, id),
    cancel: (id, b) => board.cancel(owner, id, String(b.reason ?? '')),
    comment: (id, b) => board.comment(owner, id, String(b.text ?? '')),
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { error: '허용되지 않은 접속입니다.' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(PAGE, 'utf8').replace('%%TOKEN%%', token);
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, buildState(board, paths, engineStatus()));
      }
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'task' && parts[2]) {
        const id = normalizeId(parts[2]);
        if (parts[3] === 'file') return send(res, 200, { text: readOutput(board, id, url.searchParams.get('path') ?? '') });
        return send(res, 200, taskDetail(board, id));
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        return streamEvents(req, res, board, paths);
      }

      if (req.method === 'POST') {
        if (req.headers['x-bf-token'] !== token) return send(res, 403, { error: '페이지를 새로고침해 주세요.' });
        const body = await readJson(req);
        if (url.pathname === '/api/goal') {
          const text = String(body.text ?? '').trim();
          if (!text) throw new BoardError('목표 내용이 비어 있습니다.');
          const t = board.createTask(owner, {
            title: text.split('\n')[0].slice(0, 80),
            description: text,
            assignee: config.ceo,
            doneWhen: DEFAULT_GOAL_DONE_WHEN,
            project: body.project || null,
            workspace: body.workspace || null,
            priority: Number.isInteger(body.priority) ? body.priority : 0,
            parent: null,
          });
          log(`웹: 목표 등록 ${t.id}`);
          return send(res, 200, { id: t.id });
        }
        if (parts[0] === 'api' && parts[1] === 'task' && parts[2] && actions[parts[3]]) {
          const id = normalizeId(parts[2]);
          actions[parts[3]](id, body);
          log(`웹: ${id} ${parts[3]}`);
          return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: '없는 주소입니다.' });
    } catch (err) {
      if (err instanceof BoardError || err instanceof SyntaxError) return send(res, 400, { error: err.message });
      log(`웹 오류: ${err instanceof Error ? err.stack : String(err)}`);
      send(res, 500, { error: '서버 오류' });
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    log(err.code === 'EADDRINUSE' ? `웹 화면을 열 수 없습니다: 포트 ${opts.port} 사용 중` : `웹 서버 오류: ${err.message}`);
  });
  server.listen(opts.port, '127.0.0.1', () => log(`웹 화면: http://127.0.0.1:${opts.port}`));
  return server;
}

/**
 * Server-sent events: new engine.log lines as `log`, and `changed` whenever the board,
 * staff or usage changes, so the page refetches state.
 */
function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, board: Board, paths: Paths): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const logFile = path.join(paths.company, 'engine.log');
  let offset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  let carry = '';
  let signature = '';

  // Recent history first, so the feed is not empty on load.
  if (fs.existsSync(logFile)) {
    const recent = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-60);
    for (const line of recent) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
  }

  const tick = () => {
    try {
      if (fs.existsSync(logFile)) {
        const size = fs.statSync(logFile).size;
        if (size < offset) offset = 0;
        if (size > offset) {
          const fd = fs.openSync(logFile, 'r');
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = size;
          const text = carry + buf.toString('utf8');
          const cut = text.lastIndexOf('\n');
          carry = cut === -1 ? text : text.slice(cut + 1);
          if (cut !== -1) {
            for (const line of text.slice(0, cut).split('\n')) {
              if (line) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
            }
          }
        }
      }
      const tasks = board.list();
      const usage = fs.existsSync(path.join(paths.company, '.engine-usage.json'))
        ? fs.statSync(path.join(paths.company, '.engine-usage.json')).mtimeMs
        : 0;
      const staff = fs.existsSync(paths.agents) ? fs.readdirSync(paths.agents).join(',') : '';
      const sig = `${tasks.length}|${tasks.map((t) => t.updated_at).sort().pop() ?? ''}|${usage}|${staff}`;
      if (sig !== signature) {
        if (signature) res.write(`event: changed\ndata: {}\n\n`);
        signature = sig;
      }
      res.write(`: ping\n\n`);
    } catch {
      // keep the stream alive; the next tick will retry
    }
  };
  tick();
  const timer = setInterval(tick, 1500);
  req.on('close', () => clearInterval(timer));
}
