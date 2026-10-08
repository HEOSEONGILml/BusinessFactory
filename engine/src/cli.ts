import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { listAgents } from './agents.ts';
import { Board, BoardError, DEFAULT_GOAL_DONE_WHEN, isTerminal, normalizeId, STATUS_LABEL, STATUSES } from './board.ts';
import type { Status, Task } from './board.ts';
import { initCompany } from './company.ts';
import { loadConfig } from './config.ts';
import { Engine } from './engine.ts';
import { addMemory, listMemory, readMemory } from './memory.ts';
import { listConvs, ownerSpokeInMeeting, postMessage, readMessages, resolveTarget, transcript } from './chat.ts';
import { discardHires, installHires, pendingProposals, stageProposals } from './staff.ts';
import { printUsage } from './usage.ts';
import { formatUsageSnapshot, lastActivity, readUsageSnapshot, watch } from './watch.ts';
import { startWeb, statusLabel } from './web.ts';
import { spawn } from 'node:child_process';
import { resolvePaths } from './paths.ts';

const HELP = `bf — BusinessFactory 업무 보드

사용자
  bf init [--no-git]                      회사 데이터 폴더 생성
  bf goal "<목표>" [--done-when ...]       최상위 목표 지시 (ceo 배정)
       [--project p] [--workspace w] [--priority n]
  bf status                               회사 현황
  bf agents                               직원 목록
  bf engine [--once]                      엔진 실행 (--once: 할 일이 없어질 때까지만)
  bf inbox                                결재·질문·완료 보고 모음
  bf approve <id> [--note "<메모>"]        결재 승인 (채용 포함)
  bf deny <id> "<사유>"                    결재 반려
  bf ack <id>                             완료된 목표 확인 처리
  bf usage [--days n]                     사용량 요약 (구독 사용 비율 포함)
  bf watch [<id>]                         직원들의 활동을 실시간으로 보기
  bf web                                  웹 화면을 엔진 꺼진 상태로 켜기 (화면에서 가동)

업무
  bf task create --to <직원> --title "<제목>" --done-when "<조건>" [--done-when ...]
       [--desc "<설명>"] [--depends T0001 ...] [--no-review]
       [--workspace w] [--project p] [--priority n]
  bf task list [--all] [--status s] [--assignee a] [--project p]
  bf task show <id>
  bf task done <id> --summary "<요약>"
  bf task ask <id> [--owner] "<질문>"      (--owner: 사용자에게 직접)
  bf task ask <id> [--owner] --item "<질문1>" --item "<질문2>"   (여러 건을 건별로)
  bf task answer <id> [--item n] "<답변>"
  bf task pass <id> [--note "<메모>"]
  bf task reject <id> "<사유>"
  bf task comment <id> "<내용>"
  bf task cancel <id> [--reason "<사유>"]

결재·채용·기억 (직원용)
  bf approval request <id> "<무엇을, 왜>" [--need "<권한 규칙>" ...]
  bf hire propose <id> <채용안.md> [...]
  bf hire list
  bf memory list | bf memory show <주제>
  bf memory add <주제> "<내용>" [--title "<새 주제 제목>"]

메신저 (대화용 — 실제 일은 목표·업무로)
  bf chat list                            채널·DM·회의 목록
  bf chat read <#채널|@직원|대화id> [--limit n]
  bf chat post <#채널|@직원|대화id> "<메시지>"   (@이름 으로 부르면 그 직원이 답장)
  bf dm <직원> "<메시지>"

환경변수
  BF_ACTOR  호출자 (기본: owner)   BF_TASK  현재 수행 중인 업무
`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
};

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = defaultIo): number {
  try {
    return run(argv, env, io);
  } catch (e) {
    if (e instanceof BoardError) {
      io.err(`오류: ${e.message}`);
      return 1;
    }
    if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) {
      io.err(`오류: ${e.message}\n\n${HELP}`);
      return 2;
    }
    throw e;
  }
}

function run(argv: string[], env: NodeJS.ProcessEnv, io: Io): number {
  const paths = resolvePaths(env);
  const config = loadConfig(paths);
  const board = new Board(paths, config);
  const actor = env.BF_ACTOR || config.owner;
  const currentTask = env.BF_TASK ? normalizeId(env.BF_TASK) : null;
  const [cmd, sub, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(HELP);
      return 0;

    case 'init': {
      const { values } = parseArgs({ args: argv.slice(1), options: { 'no-git': { type: 'boolean' } } });
      const res = initCompany(paths, { git: !values['no-git'] });
      io.out(`회사 데이터: ${paths.company}`);
      for (const f of res.created) io.out(`  생성: ${f}`);
      io.out(`  git: ${res.git}`);
      return 0;
    }

    case 'goal': {
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          'done-when': { type: 'string', multiple: true },
          project: { type: 'string' },
          workspace: { type: 'string' },
          priority: { type: 'string' },
        },
      });
      if (actor !== config.owner) throw new BoardError('목표는 사용자만 지시할 수 있습니다.');
      const text = positionals.join(' ').trim();
      if (!text) throw new BoardError('목표 내용이 비어 있습니다.');
      const task = board.createTask(actor, {
        title: firstLine(text),
        description: text,
        assignee: config.ceo,
        doneWhen: values['done-when'] ?? DEFAULT_GOAL_DONE_WHEN,
        project: values.project ?? null,
        workspace: values.workspace ?? null,
        priority: parsePriority(values.priority),
        parent: null,
      });
      io.out(`목표 등록: ${task.id} → ${task.assignee}`);
      return 0;
    }

    case 'status':
      printStatus(board, io);
      return 0;

    case 'agents': {
      const agents = listAgents(paths);
      if (agents.length === 0) io.out(`직원이 없습니다. (${paths.agents})`);
      for (const a of agents) io.out(`${a.name.padEnd(14)} ${(a.model ?? '-').padEnd(7)} ${a.description}`);
      return 0;
    }

    case 'task':
      return runTask(sub, rest, { board, actor, currentTask, io });

    case 'inbox':
      printInbox(board, io);
      return 0;

    case 'approve': {
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: { note: { type: 'string' } },
      });
      const task = board.approve(actor, requireId(positionals), values.note ?? '', (names) => installHires(paths, names));
      io.out(`${task.id} 결재 승인 → ${STATUS_LABEL[task.status]}`);
      return 0;
    }

    case 'deny': {
      const [id, ...text] = argv.slice(1);
      const task = board.deny(actor, requireId([id]), text.join(' '), (names) => discardHires(paths, names));
      io.out(`${task.id} 결재 반려 → ${STATUS_LABEL[task.status]}`);
      return 0;
    }

    case 'ack': {
      const task = board.acknowledge(actor, requireId(argv.slice(1)));
      io.out(`${task.id} 확인했습니다.`);
      return 0;
    }

    case 'approval': {
      if (sub !== 'request') throw new BoardError('사용법: bf approval request <id> "<내용>" [--need "<권한>"]');
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { need: { type: 'string', multiple: true } },
      });
      const [id, ...text] = positionals;
      const task = board.requestApproval(actor, requireId([id]), text.join(' '), values.need ?? []);
      io.out(`${task.id} → 결재 대기. 지금 실행을 마치세요; 결정이 나면 다시 시작됩니다.`);
      return 0;
    }

    case 'hire': {
      if (sub === 'list') {
        const list = pendingProposals(paths);
        if (list.length === 0) io.out('승인 대기 중인 채용안이 없습니다.');
        for (const p of list) {
          io.out(`${p.name.padEnd(16)} ${(p.model ?? '-').padEnd(7)} ${p.description}`);
          io.out(`    도구: ${p.tools.join(', ') || '(전체)'}  추가 권한: ${p.permissions.join(', ') || '-'}`);
          io.out(`    ${p.file}`);
        }
        return 0;
      }
      if (sub !== 'propose') throw new BoardError('사용법: bf hire propose <id> <채용안.md> ... | bf hire list');
      const [id, ...files] = rest;
      const taskId = requireId([id]);
      if (files.length === 0) throw new BoardError('채용안 파일이 필요합니다.');
      const before = board.read(taskId).task;
      if (actor !== config.owner && actor !== before.assignee) {
        throw new BoardError(`${taskId} 의 담당자는 ${before.assignee} 입니다.`);
      }
      if (before.status !== 'running') throw new BoardError(`${taskId} 는 진행 중이 아닙니다.`);
      const proposals = stageProposals(paths, files.map((f) => path.resolve(f)));
      const task = board.requestHire(actor, taskId, proposals.map((p) => p.name));
      io.out(`${task.id} → 채용 결재 대기 (${proposals.map((p) => p.name).join(', ')}). 지금 실행을 마치세요.`);
      return 0;
    }

    case 'memory': {
      if (sub === 'list' || sub === undefined) {
        const topics = listMemory(paths);
        if (topics.length === 0) io.out('회사 기억이 아직 없습니다.');
        for (const t of topics) io.out(`${t.topic.padEnd(24)} ${t.title} (${t.entries}건)  ${t.file}`);
        return 0;
      }
      if (sub === 'show') {
        io.out(readMemory(paths, rest[0] ?? ''));
        return 0;
      }
      if (sub === 'add') {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { title: { type: 'string' } },
        });
        const [topic, ...text] = positionals;
        const t = addMemory(paths, {
          topic: topic ?? '',
          text: text.join(' '),
          title: values.title,
          actor,
          task: currentTask,
          at: new Date(),
        });
        io.out(`기억에 추가: ${t.topic} (${t.entries}건)`);
        return 0;
      }
      throw new BoardError('사용법: bf memory list | show <주제> | add <주제> "<내용>" [--title ...]');
    }

    case 'chat':
    case 'dm': {
      const names = listAgents(paths).map((a) => a.name);
      if (cmd === 'dm' || sub === 'post') {
        const [target, ...text] = cmd === 'dm' ? [`@${sub ?? ''}`, ...rest] : rest;
        if (!target || target === '@') throw new BoardError('받는 곳이 필요합니다. 예: bf chat post #general "..."');
        const conv = resolveTarget(paths, target, actor, names);
        // Messages from the owner start a chain; anything an employee says is already one hop in.
        const msg = postMessage(paths, conv.id, actor, text.join(' '), { chain: actor === config.owner ? 0 : 1, names });
        if (conv.kind === 'meeting' && actor === config.owner) ownerSpokeInMeeting(paths, conv.id, msg.mentions, names);
        io.out(`${conv.title} 에 보냈습니다.${msg.mentions.length ? ` (${msg.mentions.join(', ')} 에게 답장 요청)` : ''}`);
        return 0;
      }
      if (sub === 'read') {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { limit: { type: 'string' } } });
        if (!positionals[0]) throw new BoardError('읽을 대화가 필요합니다. 예: bf chat read #general');
        const conv = resolveTarget(paths, positionals[0], actor, names);
        const msgs = readMessages(paths, conv.id, Number(values.limit ?? 30));
        io.out(`== ${conv.title} ==`);
        io.out(msgs.length ? transcript(msgs) : '(메시지 없음)');
        return 0;
      }
      if (sub === 'list' || sub === undefined) {
        const convs = listConvs(paths).filter((c) => c.kind !== 'dm' || c.members.includes(actor) || actor === config.owner);
        if (convs.length === 0) io.out('대화가 아직 없습니다.');
        for (const c of convs) io.out(`${c.kind.padEnd(8)} ${c.id.padEnd(36)} ${c.title}${c.status ? ` [${c.status}]` : ''}`);
        return 0;
      }
      throw new BoardError('사용법: bf chat list | read <대상> | post <대상> "<메시지>" | bf dm <직원> "<메시지>"');
    }

    case 'usage': {
      const { values } = parseArgs({ args: argv.slice(1), options: { days: { type: 'string' } } });
      const snap = readUsageSnapshot(paths);
      if (snap) io.out(formatUsageSnapshot(snap));
      printUsage(paths, Number(values.days ?? 7), io.out);
      return 0;
    }

    default:
      io.err(`알 수 없는 명령: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

interface TaskCtx {
  board: Board;
  actor: string;
  currentTask: string | null;
  io: Io;
}

function runTask(sub: string | undefined, args: string[], ctx: TaskCtx): number {
  const { board, actor, io } = ctx;

  switch (sub) {
    case 'create': {
      const { values } = parseArgs({
        args,
        options: {
          to: { type: 'string' },
          title: { type: 'string' },
          desc: { type: 'string' },
          'done-when': { type: 'string', multiple: true },
          depends: { type: 'string', multiple: true },
          'no-review': { type: 'boolean' },
          workspace: { type: 'string' },
          project: { type: 'string' },
          priority: { type: 'string' },
        },
      });
      if (!values.to) throw new BoardError('담당 직원(--to)이 필요합니다.');
      const task = board.createTask(actor, {
        title: values.title ?? '',
        assignee: values.to,
        description: values.desc,
        doneWhen: values['done-when'] ?? [],
        dependsOn: (values.depends ?? []).flatMap((d) => d.split(',')).filter(Boolean),
        review: !values['no-review'],
        workspace: values.workspace,
        project: values.project,
        priority: values.priority === undefined ? undefined : parsePriority(values.priority),
        parent: ctx.currentTask,
      });
      io.out(`업무 생성: ${task.id} → ${task.assignee}${task.parent ? ` (상위 ${task.parent})` : ''}`);
      return 0;
    }

    case 'list': {
      const { values } = parseArgs({
        args,
        options: {
          all: { type: 'boolean' },
          status: { type: 'string' },
          assignee: { type: 'string' },
          project: { type: 'string' },
        },
      });
      if (values.status && !STATUSES.includes(values.status as Status)) {
        throw new BoardError(`알 수 없는 상태: ${values.status} (가능: ${STATUSES.join(', ')})`);
      }
      const tasks = board
        .list()
        .filter((t) => values.all || values.status || !isTerminal(t.status))
        .filter((t) => !values.status || t.status === values.status)
        .filter((t) => !values.assignee || t.assignee === values.assignee)
        .filter((t) => !values.project || t.project === values.project);
      if (tasks.length === 0) io.out('해당하는 업무가 없습니다.');
      for (const t of tasks) io.out(formatRow(t));
      return 0;
    }

    case 'show': {
      const id = requireId(args);
      const { task, body } = board.read(id);
      io.out(`${task.id} ${task.title}`);
      io.out(
        `상태: ${statusLabel(task)}  담당: ${task.assignee}  지시: ${task.created_by}` +
          `  상위: ${task.parent ?? '-'}  깊이: ${task.depth}`,
      );
      io.out(
        `검수: ${task.review ? '예' : '아니오'}  시도: ${task.attempts}/${task.max_attempts}` +
          `  반려: ${task.rejections}/${task.max_rejections}  우선순위: ${task.priority}`,
      );
      if (task.depends_on.length) io.out(`선행: ${task.depends_on.join(', ')}`);
      if (task.project || task.workspace) io.out(`프로젝트: ${task.project ?? '-'}  작업공간: ${task.workspace ?? '-'}`);
      if (task.ask_to) io.out(`질문 대상: ${task.ask_to}`);
      const kids = board.children(id);
      if (kids.length) {
        io.out('하위 업무:');
        for (const k of kids) io.out(`  ${formatRow(k)}`);
      }
      io.out('');
      io.out(body.trimEnd());
      io.out('');
      io.out('## 이력');
      io.out('');
      io.out(board.readLog(id).trimEnd());
      return 0;
    }

    case 'done': {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { summary: { type: 'string' } },
      });
      const task = board.done(actor, requireId(positionals), values.summary ?? '');
      io.out(`${task.id} → ${STATUS_LABEL[task.status]}`);
      return 0;
    }

    case 'ask': {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { owner: { type: 'boolean' }, item: { type: 'string', multiple: true } },
      });
      const [id, ...text] = positionals;
      const task = board.ask(actor, requireId([id]), text.join(' '), values.owner ?? false, values.item ?? []);
      io.out(`${task.id} → 질문대기 (답변자: ${task.ask_to}). 지금 실행을 마치세요; 답변이 오면 다시 시작됩니다.`);
      return 0;
    }

    case 'answer': {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { item: { type: 'string' } } });
      const [id, ...text] = positionals;
      const task = board.answer(actor, requireId([id]), text.join(' '), values.item === undefined ? undefined : Number(values.item));
      io.out(`${task.id} → ${STATUS_LABEL[task.status]}`);
      return 0;
    }

    case 'pass': {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { note: { type: 'string' } },
      });
      const task = board.pass(actor, requireId(positionals), values.note ?? '');
      io.out(`${task.id} → ${STATUS_LABEL[task.status]}`);
      return 0;
    }

    case 'reject': {
      const [id, ...text] = args;
      const task = board.reject(actor, requireId([id]), text.join(' '));
      io.out(`${task.id} → ${STATUS_LABEL[task.status]} (반려 ${task.rejections}/${task.max_rejections})`);
      return 0;
    }

    case 'comment': {
      const [id, ...text] = args;
      board.comment(actor, requireId([id]), text.join(' '));
      io.out('기록했습니다.');
      return 0;
    }

    case 'cancel': {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { reason: { type: 'string' } },
      });
      const task = board.cancel(actor, requireId(positionals), values.reason ?? '');
      io.out(`${task.id} → ${STATUS_LABEL[task.status]}`);
      return 0;
    }

    default:
      io.err(`알 수 없는 task 명령: ${sub ?? '(없음)'}\n\n${HELP}`);
      return 2;
  }
}

function printInbox(board: Board, io: Io): void {
  const owner = board.config.owner;
  const tasks = board.list();
  const approvals = tasks.filter((t) => t.status === 'blocked' && t.approval);
  const questions = tasks.filter((t) => t.status === 'blocked' && !t.approval && t.ask_to === owner);
  const finished = tasks.filter((t) => t.parent === null && isTerminal(t.status) && !t.acknowledged);
  if (!approvals.length && !questions.length && !finished.length) {
    io.out('처리할 일이 없습니다.');
    return;
  }
  if (approvals.length) {
    io.out('■ 결재 대기  (bf approve <id> / bf deny <id> "<사유>")');
    for (const t of approvals) {
      io.out(`  ${t.id} [${t.assignee}] ${t.approval!.what}`);
      if (t.approval!.grants.length) io.out(`      요청 권한: ${t.approval!.grants.join(', ')}`);
      if (t.approval!.hires.length) io.out('      채용안 내용: bf hire list');
    }
  }
  if (questions.length) {
    io.out('■ 질문  (bf task answer <id> "<답변>")');
    for (const t of questions) {
      io.out(`  ${t.id} [${t.assignee}] ${t.title}`);
      if (t.questions?.length) {
        for (const q of t.questions) {
          const head = q.text.split('\n')[0];
          io.out(`      ${q.id}/${t.questions.length} ${q.answer === null ? head : `✅ ${head} — 답변: ${q.answer}`}`);
        }
        io.out(`      → bf task answer ${Number(t.id.slice(1))} --item <번호> "<답변>"   (전문: bf task show ${Number(t.id.slice(1))})`);
      } else {
        const asked = board.readLog(t.id).split('\n').filter((l) => l.includes('] 질문:')).pop() ?? '';
        io.out(`      ${asked.replace(/^- \S+ /, '')}`);
      }
    }
  }
  if (finished.length) {
    io.out('■ 끝난 목표  (bf task show <id> 로 보고 확인 후 bf ack <id>)');
    for (const t of finished) {
      io.out(`  ${formatRow(t)}`);
      io.out(`      결과물: ${path.join(board.taskDir(t.id), 'output')}`);
    }
  }
}

function printStatus(board: Board, io: Io): void {
  const tasks = board.list();
  const counts = new Map<Status, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  io.out(`업무 ${tasks.length}건: ` + STATUSES.filter((s) => counts.get(s)).map((s) => `${STATUS_LABEL[s]} ${counts.get(s)}`).join(' · '));

  const goals = tasks.filter((t) => t.parent === null);
  if (goals.length) {
    io.out('\n목표');
    for (const g of goals) io.out(`  ${formatRow(g)}`);
  }
  const attention = tasks.filter((t) => t.status === 'blocked' && t.ask_to === board.config.owner);
  if (attention.length) io.out(`\n사용자 처리 필요 ${attention.length}건 → bf inbox`);
  const active = tasks.filter((t) => t.status === 'running');
  if (active.length) {
    io.out('\n진행 중');
    for (const t of active) {
      io.out(`  ${formatRow(t)}`);
      const last = lastActivity(board.taskDir(t.id));
      if (last) io.out(`      ▸ ${last}`);
    }
  }
  const snap = readUsageSnapshot(board.paths);
  if (snap) io.out(`\n${formatUsageSnapshot(snap)}`);
}

function formatRow(t: Task): string {
  return `${t.id}  ${statusLabel(t).padEnd(5)} ${t.assignee.padEnd(12)} ${t.title}`;
}

function requireId(positionals: (string | undefined)[]): string {
  const raw = positionals[0];
  if (!raw) throw new BoardError('업무 번호가 필요합니다.');
  return normalizeId(raw);
}

function parsePriority(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new BoardError(`우선순위는 정수여야 합니다: ${raw}`);
  return n;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 80 ? line.slice(0, 77) + '...' : line;
}

/** `bf engine`: the long-running scheduler. Only one may run per company. */
/**
 * `bf engine` / `npm start`: the engine plus the web console in one process. Only one per company.
 * `bf web` is the same process starting with the engine switched off.
 */
export async function runEngine(argv: string[], env: NodeJS.ProcessEnv = process.env, opts: { webOnly?: boolean } = {}): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { once: { type: 'boolean' } } });
  const paths = resolvePaths(env);
  if (!fs.existsSync(paths.board)) {
    console.error('회사 데이터가 없습니다. 먼저 bf init 을 실행하세요.');
    return 1;
  }
  const lockDir = path.join(paths.company, '.engine');
  const pidFile = path.join(lockDir, 'pid');
  try {
    fs.mkdirSync(lockDir);
  } catch {
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : NaN);
    if (pid && isAlive(pid)) {
      console.error(`이미 실행 중입니다 (pid ${pid}). 웹 화면: http://127.0.0.1:${loadConfig(paths).web.port}`);
      return 1;
    }
  }
  fs.writeFileSync(pidFile, String(process.pid));
  const config = loadConfig(paths);
  const stateFile = path.join(paths.company, '.engine-state.json');
  let remembered = true;
  try {
    remembered = JSON.parse(fs.readFileSync(stateFile, 'utf8')).enabled !== false;
  } catch {
    // first start: on
  }
  const engine = new Engine(paths, config, { startEnabled: values.once ? true : opts.webOnly ? false : remembered });
  const web = config.web.enabled && !values.once
    ? startWeb(paths, config, {
        port: config.web.port,
        engineStatus: () => ({
          running: true,
          enabled: engine.isEnabled,
          stopping: !engine.isEnabled && engine.runningCount > 0,
          pausedUntil: engine.pausedUntilTime?.toISOString() ?? null,
          halted: engine.halted,
          active: engine.activeRuns(),
        }),
        control: { start: () => engine.setEnabled(true), stop: () => engine.setEnabled(false) },
      })
    : null;
  if (web && config.web.open_browser) openBrowser(`http://127.0.0.1:${config.web.port}`);
  try {
    if (values.once) {
      await engine.runUntilIdle();
    } else {
      const ac = new AbortController();
      const stop = () => {
        console.log('정지 요청 받음. 진행 중인 실행이 끝나면 종료합니다.');
        ac.abort();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await engine.loop(ac.signal);
    }
  } finally {
    web?.close();
    web?.closeAllConnections();
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  if (engine.pausedUntilTime) console.log(`사용량 한도로 ${engine.pausedUntilTime.toLocaleString()} 까지 대기 중이었습니다.`);
  return engine.halted ? 3 : 0;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  // Output piped into something that stopped reading (e.g. `| head`): just stop.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  const argv = process.argv.slice(2);
  if (argv[0] === 'engine') {
    runEngine(argv.slice(1)).then((code) => (process.exitCode = code));
  } else if (argv[0] === 'web') {
    runEngine(argv.slice(1), process.env, { webOnly: true }).then((code) => (process.exitCode = code));
  } else if (argv[0] === 'watch') {
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    const filter = argv[1] ? normalizeId(argv[1]) : null;
    watch(resolvePaths(), filter, ac.signal);
  } else {
    process.exitCode = main(argv);
  }
}
