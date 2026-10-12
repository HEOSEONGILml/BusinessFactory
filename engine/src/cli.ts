import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { listAgents } from './agents.ts';
import { Board, BoardError, DEFAULT_GOAL_DONE_WHEN, isMissionStep, isTerminal, normalizeId, STATUS_LABEL, STATUSES } from './board.ts';
import type { Status, Task } from './board.ts';
import { initCompany } from './company.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { Engine } from './engine.ts';
import { addMemory, listMemory, readMemory } from './memory.ts';
import {
  charterOf,
  checkCharterActor,
  createMission,
  descendantsOf,
  journalFile,
  missionExists,
  listMissions,
  MISSION_STATUS_LABEL,
  missionFile,
  missionShare,
  missionSteps,
  missionUsage,
  normalizeMissionId,
  pauseMission,
  proposeOrDecide,
  readJournal,
  readMission,
  resumeMission,
  setCharter,
  setMission,
  stopMission,
} from './missions.ts';
import { getConv, lastOwnerMessage, listConvs, ownerSpokeInMeeting, postMessage, readMessages, resolveTarget, transcript } from './chat.ts';
import { discardHires, installHires, pendingProposals, stageProposals } from './staff.ts';
import { printUsage } from './usage.ts';
import { pushAfterDone } from './remote.ts';
import { integrateWorktree } from './worktree.ts';
import { formatUsageSnapshot, lastActivity, readUsageSnapshot, watch } from './watch.ts';
import { startWeb, statusLabel } from './web.ts';
import { clearPassword, setPassword } from './webauth.ts';
import { spawn } from 'node:child_process';
import { resolvePaths } from './paths.ts';
import type { Paths } from './paths.ts';

const HELP = `bf — BusinessFactory 업무 보드

사용자
  bf init [--no-git]                      회사 데이터 폴더 생성
  bf goal "<목표>" [--done-when ...]       최상위 목표 지시 (ceo 배정)
       [--project p] [--workspace w] [--priority n]
  bf status                               회사 현황
  bf agents                               직원 목록
  bf engine [--once]                      엔진 실행 (--once: 할 일이 없어질 때까지만)
  bf engine-check                         엔진이 살아 있는지 확인 (0: 정상, 1: 꺼짐, 2: 멈춤)
  bf inbox                                결재·질문·완료 보고 모음
  bf approve <id> [--note "<메모>"]        결재 승인 (채용 포함)
  bf deny <id> "<사유>"                    결재 반려
  bf ack <id>                             완료된 목표 확인 처리
  bf usage [--days n]                     사용량 요약 (구독 사용 비율 포함)
  bf watch [<id>]                         직원들의 활동을 실시간으로 보기
  bf web                                  웹 화면을 엔진 꺼진 상태로 켜기 (화면에서 가동)
  bf web-password [--off]                 웹 화면 로그인 암호 설정 (--off: 해제). 외부 접속 전에 필수

미션 (분기 규모의 방향. 엔진이 단계 목표를 차례로 만들어 스스로 진행)
  bf mission create "<제목>" [--brief "<헌장>"] [--file 헌장.md] [--weight w]
       [--until 2026-12-31] [--project p] [--workspace w]          등록 (사용자)
  bf mission list | bf mission show <M001> [--journal n]
  bf mission pause <M001> [--reason ...] | resume <M001>          (사용자)
  bf mission stop <M001> [--cancel-running] [--reason ...]        (사용자)
  bf mission set <M001> [--weight w] [--until 날짜|""] [--title ...]   (사용자)
  bf mission charter <M001> --file <파일> | --text "<헌장>"         헌장 보강 (단계 담당자·사용자)
  bf mission achieve <M001> --summary "<근거>"                    달성 제안 (단계 담당자, 검수 통과 시 확정)
  bf mission stall <M001> --reason "<이유>"                       진전 없음 선언 (단계 담당자)
  bf mission attach <M001> <업무>                                 대화에서 등록된 업무와 그 하위를 미션 소속으로 (사용자)

업무
  bf task create --to <직원> --title "<제목>" --done-when "<조건>" [--done-when ...]
       [--desc "<설명>"] [--depends T0001 ...] [--no-review]
       [--workspace w] [--project p] [--priority n]
  bf task create --plan-review [--desc "<볼 점>"]   지금 업무의 output/plan.md 비판 검토를 reviewer 에게
  bf task list [--all] [--status s] [--assignee a] [--project p]
  bf task show <id>
  bf task done <id> --summary "<요약>"
  bf task ask <id> [--owner] "<질문>"      (--owner: 사용자에게 직접)
  bf task ask <id> [--owner] --item "<질문1>" --item "<질문2>"   (여러 건을 건별로)
  bf task answer <id> [--item n] "<답변>"
  bf task pass <id> [--note "<메모>"]
  bf task reject <id> "<사유>"
  bf task comment <id> "<내용>" [--item <번호>]
  bf task reopen <id> ["<사유>"]          끝낸 사용자 업무를 다시 열기 (사용자)
  bf task cancel <id> [--reason "<사유>"]

결재·채용·기억 (직원용)
  bf approval request <id> "<무엇을, 왜>" [--need "<권한 규칙>" ...]
  bf hire propose <id> <채용안.md> [...]
  bf hire list
  bf memory list | bf memory show <주제>
  bf memory add <주제> "<내용>" [--title "<새 주제 제목>"]

메신저 (대화용 — 부탁받은 일은 bf chat task 로 업무 등록)
  bf chat list                            채널·DM·회의 목록
  bf chat read <#채널|@직원|대화id> [--limit n]
  bf chat post <#채널|@직원|대화id> "<메시지>"   (@이름 으로 부르면 그 직원이 답장)
  bf chat task --title ... --done-when ... [--to 직원] [--desc ...] [--workspace ...] [--no-review]
                                          메신저·회의에서 사용자가 부탁한 일을 업무로 등록 (결과는 그 대화에 보고)
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

    case 'mission':
      return runMission(sub, rest, { board, actor, currentTask, io });

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
      if (task.status === 'running') io.out(`${task.id} → 자율 운영 설정으로 자동 승인되었습니다. 이어서 진행하세요.`);
      else io.out(`${task.id} → 결재 대기. 지금 실행을 마치세요; 결정이 나면 다시 시작됩니다.`);
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
      const task = board.requestHire(actor, taskId, proposals.map((p) => p.name), (names) => installHires(paths, names));
      if (task.status === 'running') {
        io.out(`${task.id} → 자율 운영 설정으로 채용 자동 승인 (${proposals.map((p) => p.name).join(', ')}). 이어서 진행하세요.`);
        return 0;
      }
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
      if (sub === 'task') return chatTask(rest, { board, actor, currentTask, io }, env, names);
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
      throw new BoardError('사용법: bf chat list | read <대상> | post <대상> "<메시지>" | task --title ... --done-when ... | bf dm <직원> "<메시지>"');
    }

    case 'usage': {
      const { values } = parseArgs({ args: argv.slice(1), options: { days: { type: 'string' } } });
      const snap = readUsageSnapshot(paths);
      if (snap) io.out(formatUsageSnapshot(snap));
      printUsage(paths, Number(values.days ?? 7), io.out);
      return 0;
    }

    case 'engine-check':
      return engineCheck(paths, config, io);

    default:
      io.err(`알 수 없는 명령: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

/** Most tasks one owner message can turn into (stops a chatty reply from flooding the board). */
const MAX_TASKS_PER_REQUEST = 5;

/**
 * `bf chat task`: wherever the owner asks for work — a messenger reply, a meeting, or a comment
 * on any inbox item (even a finished goal) — register it. It becomes a top-level task tied to the
 * owner's request, and its result is posted back where it was asked.
 */
/** The mission whose channel this is (#m001 → M001), when that mission exists. */
function missionOfChannel(paths: Paths, conv: { id: string; kind: string }): string | null {
  const m = conv.kind === 'channel' ? /^c-(m\d+)$/.exec(conv.id) : null;
  return m && missionExists(paths, m[1].toUpperCase()) ? m[1].toUpperCase() : null;
}

function chatTask(args: string[], ctx: TaskCtx, env: NodeJS.ProcessEnv, names: string[]): number {
  const { board, actor, io } = ctx;
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
  const owner = board.config.owner;
  if (actor === owner) throw new BoardError('사용자는 bf goal 로 목표를 등록하세요.');
  let origin: { conv: string; message: string };
  let where: string;
  let defaults: { project: string | null; workspace: string | null; mission: string | null };
  if (env.BF_CHAT) {
    const conv = getConv(board.paths, env.BF_CHAT);
    const request = lastOwnerMessage(board.paths, conv.id, owner);
    if (!request) throw new BoardError('사용자가 이 대화에서 부탁한 일이 없습니다. 업무는 사용자의 요청이 있을 때만 등록합니다.');
    origin = { conv: conv.id, message: request.id };
    const label = conv.kind === 'dm' ? 'DM' : conv.kind === 'meeting' ? `회의 "${conv.title}"` : `채널 ${conv.title}`;
    where = `${label} 에서 사용자 요청 (대화 맥락: \`bf chat read ${conv.id}\`)`;
    defaults = { project: conv.project ?? null, workspace: null, mission: missionOfChannel(board.paths, conv) };
  } else if (env.BF_THREAD) {
    const source = board.read(env.BF_THREAD).task;
    const request = board.thread(source.id).filter((e) => !e.event && e.from === owner).at(-1);
    if (!request) throw new BoardError('사용자가 이 코멘트에서 부탁한 일이 없습니다. 업무는 사용자의 요청이 있을 때만 등록합니다.');
    origin = { conv: `task:${source.id}`, message: String(request.n) };
    where = `업무 ${source.id} "${source.title}" 의 코멘트에서 사용자 요청 (맥락: \`bf task show ${source.id}\`, 결과물: ${source.id} 의 output/)`;
    defaults = { project: source.project ?? null, workspace: source.workspace ?? null, mission: source.mission ?? null };
  } else {
    throw new BoardError('bf chat task 는 메신저·회의·코멘트에서 답할 때만 씁니다. 업무 중에는 bf task create 를 쓰세요.');
  }
  const already = board.list().filter((t) => t.origin?.conv === origin.conv && t.origin.message === origin.message);
  if (already.length >= MAX_TASKS_PER_REQUEST) {
    throw new BoardError(`이 요청으로 이미 업무 ${already.length}건(${already.map((t) => t.id).join(', ')})을 만들었습니다.`);
  }
  const assignee = values.to ?? actor;
  if (!names.includes(assignee)) throw new BoardError(`존재하지 않는 직원입니다: ${assignee}`);
  const task = board.createTask(actor, {
    title: values.title ?? '',
    assignee,
    description: `${values.desc?.trim() || '(없음)'}\n\n출처: ${where}`,
    doneWhen: values['done-when'] ?? [],
    dependsOn: (values.depends ?? []).flatMap((d) => d.split(',')).filter(Boolean),
    review: !values['no-review'],
    workspace: values.workspace ?? defaults.workspace ?? undefined,
    project: values.project ?? defaults.project ?? undefined,
    priority: values.priority === undefined ? undefined : parsePriority(values.priority),
    parent: null,
    origin,
    // Asked for in a mission channel or on a mission task: the work belongs to that mission (its slots, usage).
    mission: defaults.mission ?? undefined,
  });
  io.out(`업무 등록: ${task.id} → ${task.assignee} (끝나면 결과가 ${env.BF_CHAT ? '이 대화' : '이 코멘트'}에 올라옵니다)`);
  return 0;
}

/**
 * `bf task create --plan-review`: the reviewer critiques the current task's output/plan.md before
 * the work is handed out. Not reviewed again itself (the reviewer would be checking its own critique).
 */
function planReview(values: { title?: string; desc?: string; depends?: string[] }, ctx: TaskCtx): number {
  const { board, actor, io } = ctx;
  if (!ctx.currentTask) throw new BoardError('--plan-review 는 업무를 수행 중일 때만 쓸 수 있습니다.');
  const parent = board.read(ctx.currentTask).task;
  const plan = path.join(board.taskDir(parent.id), 'output', 'plan.md');
  if (!fs.existsSync(plan)) throw new BoardError(`먼저 계획을 ${plan} 에 쓰세요.`);
  const task = board.createTask(actor, {
    title: values.title ?? `계획 검토: ${parent.title}`.slice(0, 120),
    assignee: board.config.reviewer,
    description: [
      `업무 ${parent.id} 의 계획을 실행 전에 비판적으로 검토한다.`,
      '',
      `- 계획: ${plan}`,
      `- 맥락: \`bf task show ${parent.id}\`${parent.mission ? `, 미션 헌장 ${missionFile(board.paths, parent.mission)}, 진행 기록 ${journalFile(board.paths, parent.mission)}` : ''}`,
      '- 볼 것: 목표(헌장) 대비 방향이 맞는지, 빠진 위험·결재 대상, 더 싸고 빠른 대안, 완료 조건이 파일로 판정 가능한지, 일을 너무 잘게 쪼개지 않았는지.',
      '- 지적마다 필수/권장을 붙이고 근거와 고칠 방법을 적는다. 마지막에 판정(승인 / 조건부 승인 / 재검토 필요)을 쓴다.',
      ...(values.desc?.trim() ? ['', values.desc.trim()] : []),
    ].join('\n'),
    doneWhen: ['output/plan-review.md 에 지적(필수/권장, 근거, 고칠 방법)과 최종 판정(승인/조건부 승인/재검토 필요)이 있다'],
    dependsOn: (values.depends ?? []).flatMap((d) => d.split(',')).filter(Boolean),
    review: false,
    parent: parent.id,
  });
  io.out(`계획 검토 업무 생성: ${task.id} → ${task.assignee} (상위 ${parent.id}). 지금 실행을 마치세요; 검토가 끝나면 다시 깨워집니다.`);
  return 0;
}

function runMission(sub: string | undefined, args: string[], ctx: TaskCtx): number {
  const { board, actor, io } = ctx;
  const paths = board.paths;
  const owner = board.config.owner;
  const now = new Date();
  const ownerOnly = () => {
    if (actor === owner || (board.config.autonomy && actor === board.config.ceo)) return;
    throw new BoardError(`이 명령은 사용자만 쓸 수 있습니다.${actor === board.config.ceo ? ' (company/config.yaml 의 autonomy: true 면 ceo도 쓸 수 있습니다)' : ''}`);
  };
  const parse = (options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>) =>
    parseArgs({ args, allowPositionals: true, options });

  switch (sub) {
    case 'create': {
      ownerOnly();
      const { values, positionals } = parse({
        brief: { type: 'string' },
        file: { type: 'string' },
        weight: { type: 'string' },
        until: { type: 'string' },
        project: { type: 'string' },
        workspace: { type: 'string' },
      });
      const title = positionals.join(' ').trim();
      const fromFile = values.file ? fs.readFileSync(path.resolve(String(values.file)), 'utf8') : '';
      const m = createMission(paths, actor, {
        title,
        brief: [values.brief, fromFile].filter((x) => typeof x === 'string' && x.trim()).join('\n\n'),
        weight: values.weight === undefined ? undefined : Number(values.weight),
        until: (values.until as string | undefined) ?? null,
        project: (values.project as string | undefined) ?? null,
        workspace: (values.workspace as string | undefined) ?? null,
      }, now);
      io.out(`미션 등록: ${m.id} ${m.title} — 엔진이 다음 주기에 첫 단계를 만듭니다.`);
      return 0;
    }
    case 'list':
    case undefined: {
      const missions = listMissions(paths);
      if (missions.length === 0) io.out('미션이 없습니다.');
      const tasks = board.list();
      const usage = missionUsage(paths, tasks, now.getTime() - 7 * 86_400_000);
      for (const m of missions) {
        const steps = missionSteps(tasks, m.id);
        const open = steps.find((t) => !isTerminal(t.status));
        const share = missionShare(board.config, missions, m);
        io.out(
          `${m.id}  [${MISSION_STATUS_LABEL[m.status]}]  ${m.title}  단계 ${steps.length}` +
            `${open ? ` (진행: ${open.id} ${STATUS_LABEL[open.status]})` : ''}  7일 $${(usage.get(m.id) ?? 0).toFixed(2)}` +
            `${share !== null ? `/$${share.toFixed(2)}` : ''}${m.hold ? `  대기: ${m.hold === 'budget' ? '예산' : '사용률'}` : ''}`,
        );
      }
      return 0;
    }
    case 'show': {
      const { values, positionals } = parse({ journal: { type: 'string' } });
      const id = normalizeMissionId(positionals[0]);
      const { mission: m, body } = readMission(paths, id);
      const tasks = board.list();
      const steps = missionSteps(tasks, id);
      const usage = missionUsage(paths, tasks, now.getTime() - 7 * 86_400_000);
      const share = missionShare(board.config, listMissions(paths), m);
      io.out(`${m.id} ${m.title}`);
      io.out(`상태: ${MISSION_STATUS_LABEL[m.status]}${m.paused_reason && m.status !== 'active' ? ` (${m.paused_reason})` : ''}  가중치: ${m.weight}  기한: ${m.until ?? '-'}`);
      io.out(`7일 추정 사용량: $${(usage.get(id) ?? 0).toFixed(2)}${share !== null ? ` / 몫 $${share.toFixed(2)}` : ''}${m.hold ? `  대기 중: ${m.hold === 'budget' ? '미션 예산' : '구독 사용률'}` : ''}`);
      if (m.project || m.workspace) io.out(`프로젝트: ${m.project ?? '-'}  작업공간: ${m.workspace ?? '-'}`);
      io.out(`파일: ${missionFile(paths, id)}`);
      io.out('');
      io.out('## 헌장');
      io.out('');
      io.out(charterOf(body));
      io.out('');
      io.out('## 단계');
      io.out('');
      if (steps.length === 0) io.out('(아직 없음)');
      for (const s of steps) io.out(`${formatRow(s)}  (하위 ${descendantsOf(tasks, s.id).length}건)`);
      const journal = readJournal(paths, id).trimEnd();
      const n = Number(values.journal ?? 4000);
      io.out('');
      io.out(`## 진행 기록 (${journalFile(paths, id)})`);
      io.out('');
      io.out(journal.length > n ? '…' + journal.slice(-n) : journal || '(없음)');
      return 0;
    }
    case 'pause': {
      ownerOnly();
      const { values, positionals } = parse({ reason: { type: 'string' } });
      const m = pauseMission(paths, normalizeMissionId(positionals[0]), actor, String(values.reason ?? positionals.slice(1).join(' ')), now);
      io.out(`${m.id} → 일시정지. 새 단계를 만들지 않고, 미션 업무도 새로 시작하지 않습니다.`);
      return 0;
    }
    case 'resume': {
      ownerOnly();
      const m = resumeMission(paths, normalizeMissionId(args[0]), actor, now);
      io.out(`${m.id} → 진행`);
      return 0;
    }
    case 'stop': {
      ownerOnly();
      const { values, positionals } = parse({ reason: { type: 'string' }, 'cancel-running': { type: 'boolean' } });
      const m = stopMission(board, normalizeMissionId(positionals[0]), actor, String(values.reason ?? positionals.slice(1).join(' ')), !!values['cancel-running'], now);
      io.out(`${m.id} → 중지${values['cancel-running'] ? ' (진행 중 단계 취소)' : ' (진행 중 단계는 끝까지)'}`);
      return 0;
    }
    case 'set': {
      ownerOnly();
      const { values, positionals } = parse({ weight: { type: 'string' }, until: { type: 'string' }, title: { type: 'string' } });
      const m = setMission(paths, normalizeMissionId(positionals[0]), actor, {
        weight: values.weight === undefined ? undefined : Number(values.weight),
        until: values.until as string | undefined,
        title: values.title as string | undefined,
      }, now);
      io.out(`${m.id} 설정 변경: 가중치 ${m.weight}, 기한 ${m.until ?? '-'}`);
      return 0;
    }
    case 'attach': {
      ownerOnly();
      const id = normalizeMissionId(args[0]);
      if (!missionExists(paths, id)) throw new BoardError(`없는 미션입니다: ${id}`);
      if (!args[1]) throw new BoardError('사용법: bf mission attach <M001> <업무>');
      const changed = board.attachMission(actor, normalizeId(args[1]), id);
      io.out(changed.length ? `${id} 소속으로 지정: ${changed.map((t) => t.id).join(', ')}` : `바뀐 업무가 없습니다 (이미 ${id} 소속).`);
      return 0;
    }
    case 'charter': {
      const { values, positionals } = parse({ file: { type: 'string' }, text: { type: 'string' } });
      const id = normalizeMissionId(positionals[0]);
      checkCharterActor(board, id, actor, ctx.currentTask);
      const text = values.file ? fs.readFileSync(path.resolve(String(values.file)), 'utf8') : String(values.text ?? positionals.slice(1).join(' '));
      setCharter(paths, id, actor, text, now);
      io.out(`${id} 헌장을 갱신했습니다 (원문은 보존, 변경은 진행 기록에 남음).`);
      return 0;
    }
    case 'achieve':
    case 'stall': {
      const { values, positionals } = parse({ summary: { type: 'string' }, reason: { type: 'string' } });
      const id = normalizeMissionId(positionals[0]);
      const text = String(values.summary ?? values.reason ?? positionals.slice(1).join(' '));
      io.out(proposeOrDecide(board, id, actor, ctx.currentTask, sub, text, now));
      return 0;
    }
    default:
      throw new BoardError('사용법: bf mission create|list|show|pause|resume|stop|set|attach|charter|achieve|stall (bf help 참고)');
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
          'plan-review': { type: 'boolean' },
        },
      });
      if (values['plan-review']) return planReview(values, ctx);
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
      if (task.mission) io.out(`미션: ${task.mission}${isMissionStep(task) ? ' (단계)' : ''}`);
      if (task.mission_proposal) io.out(`미션 ${task.mission_proposal.kind === 'achieve' ? '달성 제안' : '진전 없음 선언'}: ${task.mission_proposal.text}`);
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
      const id = requireId(positionals);
      const before = board.read(id).task;
      // Fold the work into the workspace first: a conflict must stop the report, not follow it.
      const merged = before.worktree && !before.worktree.removed && actor === before.assignee ? integrateWorktree(board.paths, before) : null;
      const task = board.done(actor, id, values.summary ?? '');
      if (merged) io.out(merged);
      const pushed = pushAfterDone(board, before);
      if (pushed) io.out(pushed);
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
      // Not parseArgs: comment text may itself start with '-'.
      const rest = [...args];
      const at = rest.indexOf('--item');
      const item = at === -1 ? null : Number(rest.splice(at, 2)[1]);
      const [raw, ...words] = rest;
      const id = requireId([raw]);
      const text = words.join(' ');
      // On an owner inbox item the comment joins its thread, and the assignee replies there.
      if (actor === board.config.owner && board.awaitsOwner(board.read(id).task, item)) {
        board.threadPost(actor, id, text, item);
        io.out('코멘트를 달았습니다. 담당자가 확인하고 답합니다.');
        return 0;
      }
      board.comment(actor, id, text);
      io.out('기록했습니다.');
      return 0;
    }

    case 'reopen': {
      const [id, ...text] = args;
      const task = board.reopen(actor, requireId([id]), text.join(' '));
      io.out(`${task.id} 완료를 해제했습니다 → ${STATUS_LABEL[task.status]}. 코멘트를 이어서 달 수 있습니다.`);
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
  const mine = tasks.filter((t) => board.isOwnerTask(t) && t.status === 'pending');
  const finished = tasks.filter((t) => t.parent === null && isTerminal(t.status) && !t.acknowledged && !(isMissionStep(t) && t.status === 'done'));
  if (!approvals.length && !mine.length && !questions.length && !finished.length) {
    io.out('처리할 일이 없습니다.');
    return;
  }
  const thread = (t: Task) => {
    for (const e of board.openThread(t.id)) {
      io.out(`      💬 ${e.item ? `(${e.item}번) ` : ''}${e.from === owner ? '사용자' : e.from}: ${e.text.split('\n')[0]}`);
    }
  };
  io.out('코멘트: bf task comment <id> "<내용>" [--item <번호>] — 담당자가 확인하고 코멘트로 답합니다.\n');
  if (approvals.length) {
    io.out('■ 결재 대기  (bf approve <id> / bf deny <id> "<사유>")');
    for (const t of approvals) {
      io.out(`  ${t.id} [${t.assignee}] ${t.approval!.what}`);
      if (t.approval!.grants.length) io.out(`      요청 권한: ${t.approval!.grants.join(', ')}`);
      if (t.approval!.hires.length) io.out('      채용안 내용: bf hire list');
      thread(t);
    }
  }
  if (mine.length) {
    io.out('■ 내가 할 일  (지시서: bf task show <id> / 끝나면 bf task done <id> --summary "<결과>")');
    for (const t of mine) {
      const waits = t.depends_on.filter((d) => board.read(d).task.status !== 'done');
      io.out(`  ${t.id} [${t.created_by} 요청] ${t.title}${waits.length ? `  (먼저: ${waits.join(', ')})` : ''}`);
      thread(t);
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
      thread(t);
    }
  }
  if (finished.length) {
    io.out('■ 끝난 목표  (bf task show <id> 로 보고 확인 후 bf ack <id>)');
    for (const t of finished) {
      io.out(`  ${formatRow(t)}`);
      io.out(`      결과물: ${path.join(board.taskDir(t.id), 'output')}`);
      thread(t);
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
  const attention = tasks.filter((t) => (t.status === 'blocked' && t.ask_to === board.config.owner) || (board.isOwnerTask(t) && t.status === 'pending'));
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

/**
 * Watchdog probe for an outside scheduler (systemd timer): is the engine process alive and is
 * its loop still beating? Exit 0 healthy, 1 not running, 2 running but hung.
 */
function engineCheck(paths: Paths, config: Config, io: Io): number {
  const pidFile = path.join(paths.company, '.engine', 'pid');
  const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : NaN);
  if (!pid || !isAlive(pid)) {
    io.out('엔진: 실행 중이 아님');
    return 1;
  }
  let beat: { pid?: number; at?: string; enabled?: boolean; halted?: string | null } = {};
  try {
    beat = JSON.parse(fs.readFileSync(path.join(paths.company, '.engine-heartbeat.json'), 'utf8'));
  } catch {
    // no beat yet
  }
  const age = beat.pid === pid && beat.at ? (Date.now() - Date.parse(beat.at)) / 1000 : Infinity;
  // A process that just started has not beaten yet (its first pass runs before the first beat).
  // Restarting it then kills the runs it just launched and loops the watchdog, so give it time.
  const startedAgo = (Date.now() - fs.statSync(pidFile).mtimeMs) / 1000;
  if (!Number.isFinite(age) && startedAgo <= config.watchdog.stale_seconds) {
    io.out(`엔진: 시작 중 (pid ${pid}, ${Math.round(startedAgo)}초 전 시작, 아직 신호 없음)`);
    return 0;
  }
  if (!(age <= config.watchdog.stale_seconds)) {
    io.out(`엔진: 응답 없음 (pid ${pid}, 마지막 신호 ${Number.isFinite(age) ? `${Math.round(age)}초 전` : '없음'})`);
    return 2;
  }
  const state = beat.halted ? `정지 (${firstLine(beat.halted)})` : beat.enabled ? '가동' : '꺼짐';
  io.out(`엔진: 정상 (pid ${pid}, ${state}, 마지막 신호 ${Math.round(age)}초 전)`);
  return 0;
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

/**
 * Sets or clears the web console password. Owner only: refused inside an employee run.
 * Reads the password from a hidden prompt, or from stdin when piped.
 */
async function runWebPassword(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const paths = resolvePaths(env);
  const config = loadConfig(paths);
  if (env.BF_TASK || (env.BF_ACTOR && env.BF_ACTOR !== config.owner)) {
    console.error('오류: 웹 화면 암호는 사용자만 바꿀 수 있습니다.');
    return 1;
  }
  if (args.includes('--off')) {
    console.log(clearPassword(paths) ? '웹 화면 로그인을 껐습니다.' : '설정된 암호가 없습니다.');
    return 0;
  }
  const password = process.stdin.isTTY
    ? await promptHidden('새 암호: ')
    : (await new Promise<string>((resolve) => {
        let raw = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (raw += c));
        process.stdin.on('end', () => resolve(raw));
      })).split(/\r?\n/)[0];
  if (process.stdin.isTTY && (await promptHidden('한 번 더: ')) !== password) {
    console.error('오류: 두 암호가 다릅니다.');
    return 1;
  }
  try {
    setPassword(paths, password);
  } catch (e) {
    console.error(`오류: ${(e as Error).message}`);
    return 1;
  }
  console.log('웹 화면 암호를 설정했습니다. 엔진을 다시 시작하지 않아도 바로 적용됩니다.');
  return 0;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
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
  } else if (argv[0] === 'web-password') {
    runWebPassword(argv.slice(1)).then((code) => (process.exitCode = code));
  } else if (argv[0] === 'watch') {
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    const filter = argv[1] ? normalizeId(argv[1]) : null;
    watch(resolvePaths(), filter, ac.signal);
  } else {
    process.exitCode = main(argv);
  }
}
