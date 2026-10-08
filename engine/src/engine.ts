import fs from 'node:fs';
import path from 'node:path';
import { getAgent, listAgents } from './agents.ts';
import type { AgentInfo } from './agents.ts';
import { Board, DEFAULT_GOAL_DONE_WHEN, isTerminal, STATUS_LABEL } from './board.ts';
import type { Task } from './board.ts';
import type { Config } from './config.ts';
import { writeFileAtomic } from './fsutil.ts';
import { commitCompany, staffChanges, systemStatus } from './git.ts';
import type { Paths } from './paths.ts';
import { agentToolList, isUsageLimit, parseResetTime, runAgent } from './runner.ts';
import {
  dueReplies,
  getConv,
  listConvs,
  meetingNotesDir,
  postMessage,
  readCursors,
  readMessages,
  saveConv,
  transcript,
  writeCursor,
} from './chat.ts';
import type { Conversation, DueReply } from './chat.ts';
import { dueSchedules } from './schedule.ts';
import { WINDOW_LABEL } from './stream.ts';
import type { RunEvent, UsageSnapshot } from './stream.ts';
import { buildSender, OwnerNotifier } from './notify.ts';
import type { Sender } from './notify.ts';
import type { Access, RunResult, RunSpec } from './runner.ts';

export type RunKind = 'work' | 'review';

export interface EngineOptions {
  /** Replaces the real Claude Code launcher (tests). */
  run?: (spec: RunSpec) => Promise<RunResult>;
  now?: () => Date;
  log?: (line: string) => void;
  /** Replaces desktop/phone notifications (tests). */
  notify?: Sender;
  /** Whether the engine starts switched on (default true). */
  startEnabled?: boolean;
}

interface ActiveRun {
  taskId: string;
  kind: RunKind;
  agent: string;
  workspace: string | null;
  startedAt: string;
  promise: Promise<void>;
}

export interface ActiveRunInfo {
  /** Task id, or conversation id for chat runs. */
  taskId: string;
  kind: RunKind | 'chat' | 'comment';
  agent: string;
  startedAt: string;
  /** Chat runs: conversation title and latest action (task runs read these from the board). */
  title?: string;
  activity?: string | null;
}

type ChatMode = 'reply' | 'meeting' | 'summary';

interface ChatRun {
  convId: string;
  title: string;
  agent: string;
  mode: ChatMode;
  startedAt: string;
  activity: string | null;
  promise: Promise<void>;
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** System folders whose change during a run means an employee escaped its sandbox. */
const SYSTEM_AREAS = ['engine', 'bin', 'templates', '.claude', 'docs', 'package.json', 'tsconfig.json'];

/**
 * The scheduler. It never decides *what* to do — employees do that through bf.
 * It only picks runnable work, launches employees, and records what happened.
 */
export class Engine {
  readonly board: Board;
  private readonly paths: Paths;
  private readonly config: Config;
  private readonly run: (spec: RunSpec) => Promise<RunResult>;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly active = new Map<string, ActiveRun>();
  /** Review runs that ended without a verdict, per task. */
  private readonly reviewMisses = new Map<string, number>();
  /** Tasks whose employee has no definition; reported once, then skipped. */
  private readonly missingAgent = new Set<string>();
  private pausedUntil: Date | null = null;
  private haltReason: string | null = null;
  private haltedAt: Date | null = null;
  /** Halts resumed by the watchdog in a row; each one waits twice as long. Reset by the owner. */
  private autoResumes = 0;
  private systemSnapshot: string | null = null;
  private readonly notify: Sender;
  private readonly ownerNotifier: OwnerNotifier;
  private readonly chatActive = new Map<string, ChatRun>();
  /** Assignees replying to the owner's comments on inbox items, by task id. */
  private readonly threadActive = new Map<string, ChatRun>();
  /** The on/off switch. Off: no new runs start; runs in progress finish. */
  private enabled: boolean;

  constructor(paths: Paths, config: Config, opts: EngineOptions = {}) {
    this.paths = paths;
    this.config = config;
    this.now = opts.now ?? (() => new Date());
    this.board = new Board(paths, config, this.now);
    this.run = opts.run ?? ((spec) => runAgent(spec));
    this.log = opts.log ?? ((line) => this.defaultLog(line));
    this.notify = opts.notify ?? buildSender(config.notify, this.log);
    this.ownerNotifier = new OwnerNotifier(paths, this.notify);
    this.enabled = opts.startEnabled ?? true;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get runningCount(): number {
    return this.active.size + this.chatActive.size + this.threadActive.size;
  }

  /**
   * Switch the engine on or off (web console button). Turning it on also clears a halt —
   * the owner has looked at the cause — and re-takes the system snapshot.
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled && !(on && this.haltReason)) return;
    this.enabled = on;
    if (on) {
      if (this.haltReason) this.log('정지 원인을 확인했다는 사용자 조치로 다시 가동');
      this.haltReason = null;
      this.autoResumes = 0;
      this.recover();
      this.log('엔진 가동');
    } else {
      const n = this.runningCount;
      this.log(n ? `엔진 정지 요청: 진행 중인 ${n}건을 마무리한 뒤 쉽니다` : '엔진 정지');
    }
    try {
      writeFileAtomic(path.join(this.paths.company, '.engine-state.json'), JSON.stringify({ enabled: on }));
    } catch {
      // remembering the switch is a convenience
    }
  }

  get halted(): string | null {
    return this.haltReason;
  }

  /** Who is working on what right now (for the web console's office view). */
  activeRuns(): ActiveRunInfo[] {
    return [
      ...[...this.active.values()].map(({ taskId, kind, agent, startedAt }) => ({ taskId, kind, agent, startedAt })),
      ...[...this.chatActive.values()].map((c) => ({
        taskId: c.convId,
        kind: 'chat' as const,
        agent: c.agent,
        startedAt: c.startedAt,
        title: c.mode === 'summary' ? `${c.title} 회의록 작성` : c.title,
        activity: c.activity,
      })),
      ...[...this.threadActive.values()].map((c) => ({
        taskId: c.convId,
        kind: 'comment' as const,
        agent: c.agent,
        startedAt: c.startedAt,
        title: c.title,
        activity: c.activity,
      })),
    ];
  }

  get pausedUntilTime(): Date | null {
    return this.pausedUntil;
  }

  /** Call once before the first tick. */
  recover(): void {
    this.systemSnapshot = this.snapshotSystem();
    for (const t of this.board.list()) {
      if (t.status === 'running' && !this.active.has(t.id)) {
        this.board.requeue(t.id, '엔진 재시작: 중단된 실행을 대기로 되돌림');
        this.log(`${t.id} 중단된 실행을 대기로 되돌림`);
      }
    }
  }

  /** One scheduling pass: register due recurring goals, then launch whatever fits in the free slots. */
  tick(): void {
    if (this.haltReason && !this.autoResume()) return;
    this.notifyOwner();
    if (!this.enabled) return;
    this.fireSchedules();
    if (this.pausedUntil) {
      if (this.now() < this.pausedUntil) return;
      this.log('사용량 한도 대기 종료, 재개');
      this.pausedUntil = null;
    }

    for (const { task, kind } of this.candidates()) {
      if (this.active.size >= this.config.max_concurrency) break;
      // Re-check: an earlier launch in this same pass may have taken the workspace.
      if (kind === 'work' && task.workspace && [...this.active.values()].some((a) => a.workspace === task.workspace)) {
        continue;
      }
      this.launch(task, kind);
    }
    this.tickChat();
  }

  /** Resolves when every launched run has been processed. */
  async drain(): Promise<void> {
    while (this.runningCount > 0) await Promise.race(this.allPromises());
  }

  private allPromises(): Promise<void>[] {
    return [...this.active.values(), ...this.chatActive.values(), ...this.threadActive.values()].map((a) => a.promise);
  }

  /** Runs until nothing is runnable, nothing is active, and no pause is pending. */
  async runUntilIdle(): Promise<void> {
    this.recover();
    for (;;) {
      this.tick();
      if (this.runningCount === 0) return;
      await Promise.race(this.allPromises());
    }
  }

  /** The long-running loop behind `bf engine`. */
  async loop(signal: AbortSignal): Promise<void> {
    this.recover();
    this.log(`엔진 ${this.enabled ? '시작' : '대기(꺼짐)'} (동시 실행 ${this.config.max_concurrency}, 직원 ${listAgents(this.paths).length}명)`);
    // Keeps running while switched off or halted, so the web console can turn it back on.
    while (!signal.aborted) {
      this.tick();
      this.heartbeat();
      await sleep(this.config.poll_seconds * 1000, signal);
    }
    if (this.active.size > 0) this.log(`진행 중인 실행 ${this.active.size}건이 끝나기를 기다립니다...`);
    await this.drain();
    if (this.haltReason) this.log(`엔진 정지: ${this.haltReason}`);
  }

  // ---- messenger and meetings ----

  /** Meetings speak one at a time; outside meetings, DMs and @mentions get replies. */
  private tickChat(): void {
    this.tickThreads();
    const cap = this.config.chat.max_concurrency;
    const busyConv = (id: string) => [...this.chatActive.values()].some((r) => r.convId === id);
    for (const conv of listConvs(this.paths)) {
      if (this.chatActive.size + this.threadActive.size >= cap) return;
      if (conv.kind !== 'meeting' || conv.status === 'closed' || busyConv(conv.id)) continue;
      if (conv.queue?.length) this.launchChat(conv, conv.queue[0], 'meeting');
      else if (conv.status === 'closing') this.launchChat(conv, conv.facilitator ?? conv.members[1], 'summary');
    }
    const names = listAgents(this.paths).map((a) => a.name);
    for (const due of dueReplies(this.paths, names, this.config.chat.max_chain)) {
      if (this.chatActive.size + this.threadActive.size >= cap) return;
      if (this.chatActive.has(`${due.convId}:${due.agent}`)) continue;
      this.launchChat(getConv(this.paths, due.convId), due.agent, 'reply', due);
    }
  }

  private launchChat(conv: Conversation, agentName: string, mode: ChatMode, due?: DueReply): void {
    const agent = getAgent(this.paths, agentName);
    if (!agent) {
      if (conv.kind === 'meeting') {
        conv.queue = (conv.queue ?? []).slice(1);
        if (mode === 'summary') conv.status = 'closed';
        saveConv(this.paths, conv);
      }
      if (due) writeCursor(this.paths, due.convId, agentName, due.upTo);
      return;
    }
    const previousCursor = readCursors(this.paths)[conv.id]?.[agentName];
    // Claim the messages now so the next tick doesn't launch the same reply again.
    if (due) writeCursor(this.paths, due.convId, agentName, due.upTo);
    const key = `${conv.id}:${agentName}`;
    const entry: ChatRun = {
      convId: conv.id,
      title: conv.title,
      agent: agentName,
      mode,
      startedAt: this.now().toISOString(),
      activity: null,
      promise: Promise.resolve(),
    };
    this.log(`💬 ${conv.title} — ${agentName} ${mode === 'summary' ? '회의록 작성' : '답변 작성'} 시작`);
    const spec = this.buildChatSpec(conv, agent, mode);
    spec.onEvent = (ev) => {
      if (ev.kind === 'activity') {
        entry.activity = ev.text;
        this.log(`  💬 ${conv.title} ${agentName} ▸ ${ev.text}`);
      } else {
        this.onUsage(ev.usage);
      }
    };
    entry.promise = this.run(spec)
      .then((r) => this.handleChat(conv.id, agentName, mode, r, due, previousCursor))
      .catch((err) => this.log(`💬 ${conv.title} 처리 중 오류: ${err instanceof Error ? err.stack : String(err)}`))
      .finally(() => this.chatActive.delete(key));
    this.chatActive.set(key, entry);
  }

  private buildChatSpec(conv: Conversation, agent: AgentInfo, mode: ChatMode): RunSpec {
    const chatDir = path.join(this.paths.company, 'chat');
    // No workspaces in the messenger: secrets live there.
    return this.talkSpec(agent, 'chat', this.chatPrompt(conv, agent.name, mode), chatDir, [chatDir, this.paths.board, this.paths.memory], { BF_CHAT: conv.id });
  }

  /** Talking is read-only: no file edits and no shell beyond bf. */
  private talkSpec(agent: AgentInfo, label: string, prompt: string, cwd: string, read: string[], env: Record<string, string>): RunSpec {
    const baseTools = agent.tools.length ? agent.tools : ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];
    const talker: AgentInfo = {
      ...agent,
      tools: baseTools.filter((t) => !EDIT_TOOLS.has(t)),
      permissions: agent.permissions.filter((p) => /^(WebSearch|WebFetch)\b/.test(p)),
    };
    const agentsFile = path.join(this.paths.company, '.run', `${label}-${agent.name}.json`);
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    const def: Record<string, unknown> = { description: agent.description || agent.name, prompt: agent.prompt };
    const tools = agentToolList(talker);
    if (tools) def.tools = tools;
    if (agent.model) def.model = agent.model;
    writeFileAtomic(agentsFile, JSON.stringify({ [agent.name]: def }, null, 2));
    return {
      command: this.config.claude_command,
      agent: talker,
      agentsFile,
      prompt,
      cwd,
      access: { write: [], read },
      grants: [],
      handbook: fs.existsSync(this.paths.handbook) ? this.paths.handbook : null,
      maxTurns: this.config.chat.max_turns,
      timeoutMs: this.config.chat.timeout_minutes * 60_000,
      binDir: this.paths.bin,
      env: {
        BF_ROOT: this.paths.root,
        BF_COMPANY: this.paths.company,
        BF_WORKSPACES: this.paths.workspaces,
        BF_ACTOR: agent.name,
        ...env,
      },
    };
  }

  // ---- comment threads on inbox items ----

  private threadCursorFile(): string {
    return path.join(this.paths.company, '.thread-cursors.json');
  }

  private threadCursors(): Record<string, number> {
    try {
      return JSON.parse(fs.readFileSync(this.threadCursorFile(), 'utf8'));
    } catch {
      return {};
    }
  }

  private setThreadCursor(taskId: string, n: number | undefined): void {
    const all = this.threadCursors();
    if (n === undefined) delete all[taskId];
    else all[taskId] = n;
    writeFileAtomic(this.threadCursorFile(), JSON.stringify(all));
  }

  /** The owner commented on an inbox item: the assignee reads it and answers in the thread. */
  private tickThreads(): void {
    const cap = this.config.chat.max_concurrency;
    const cursors = this.threadCursors();
    for (const task of this.board.list()) {
      if (this.chatActive.size + this.threadActive.size >= cap) return;
      if (this.threadActive.has(task.id)) continue;
      const entries = this.board.thread(task.id);
      const last = entries.at(-1);
      if (!last || last.from !== this.config.owner || last.n <= (cursors[task.id] ?? 0)) continue;
      if (!this.board.awaitsOwner(task, last.item)) continue;
      const agent = getAgent(this.paths, this.board.responder(task));
      // Claim it now so the next tick doesn't launch the same reply again.
      this.setThreadCursor(task.id, last.n);
      if (agent) this.launchThreadReply(task, agent, last.item, cursors[task.id]);
    }
  }

  private launchThreadReply(task: Task, agent: AgentInfo, item: number | null, previousCursor: number | undefined): void {
    const entry: ChatRun = {
      convId: task.id,
      title: `${task.title} 코멘트`,
      agent: agent.name,
      mode: 'reply',
      startedAt: this.now().toISOString(),
      activity: null,
      promise: Promise.resolve(),
    };
    this.log(`💬 ${task.id} — ${agent.name} 코멘트 답변 작성 시작`);
    const taskDir = this.board.taskDir(task.id);
    const read = [taskDir, this.paths.board, this.paths.memory];
    if (task.workspace) read.push(path.join(this.paths.workspaces, task.workspace));
    const spec = this.talkSpec(agent, 'thread', this.threadPrompt(task, agent.name, item), taskDir, read, {});
    spec.onEvent = (ev) => {
      if (ev.kind === 'activity') {
        entry.activity = ev.text;
        this.log(`  💬 ${task.id} ${agent.name} ▸ ${ev.text}`);
      } else {
        this.onUsage(ev.usage);
      }
    };
    entry.promise = this.run(spec)
      .then((r) => this.handleThreadReply(task.id, agent.name, item, r, previousCursor))
      .catch((err) => this.log(`💬 ${task.id} 코멘트 처리 중 오류: ${err instanceof Error ? err.stack : String(err)}`))
      .finally(() => this.threadActive.delete(task.id));
    this.threadActive.set(task.id, entry);
  }

  private threadPrompt(task: Task, agent: string, item: number | null): string {
    const owner = this.config.owner;
    const what = this.board.isOwnerTask(task)
      ? `당신이 사용자에게 맡긴 업무입니다. 지시서는 \`bf task show ${task.id}\` 로 볼 수 있습니다. 사용자가 끝내면 완료 보고가 올라옵니다.`
      : task.approval
      ? `당신이 올린 결재 요청: ${task.approval.what}${task.approval.grants.length ? ` (요청 권한: ${task.approval.grants.join(', ')})` : ''}`
      : task.status === 'blocked'
        ? `당신이 사용자에게 한 질문${item ? ` (${item}/${task.questions!.length}번)` : ''}: ${item ? task.questions!.find((q) => q.id === item)!.text : '`bf task show` 이력의 마지막 질문'}`
        : `이 목표는 ${STATUS_LABEL[task.status]} 상태로 끝났고, 사용자가 결과를 확인하는 중입니다. 결과물은 output/ 에 있습니다.`;
    const thread = this.board
      .thread(task.id, item)
      .map((e) => `[${e.from === owner ? '사용자' : e.from}] ${e.text}`)
      .join('\n\n');
    return [
      `[코멘트] 당신은 ${agent} 입니다. 업무 ${task.id} "${task.title}" 의 처리할 일에 사용자가 코멘트를 달았습니다.`,
      what,
      '',
      '코멘트 (오래된 것 → 최신):',
      '---',
      thread,
      '---',
      '',
      '사용자의 마지막 코멘트에 코멘트로 답하세요.',
      '- 최종 출력은 코멘트 본문 그대로입니다. 인사말, 서명, 따옴표 없이 씁니다.',
      '- 질문에는 직접 답하고, 사용자의 말을 어떻게 이해했는지와 그래서 무엇을 할지 짧고 구체적으로 씁니다. 필요한 것이 더 있으면 물어봅니다.',
      `- 사실 확인이 필요하면 \`bf task show ${task.id}\` 와 파일 읽기로 확인합니다. 추측은 추측이라고 밝힙니다.`,
      '- 지금은 코멘트만 답니다. 업무 상태를 바꾸는 bf 명령(done, ask, answer 등)은 쓰지 마세요. 진행 여부는 사용자가 답변 확정·승인·확인 버튼으로 정합니다.',
      '- bf 로 따로 코멘트를 남기지 마세요. 최종 출력이 곧 코멘트입니다.',
    ].join('\n');
  }

  private handleThreadReply(taskId: string, agent: string, item: number | null, r: RunResult, previousCursor: number | undefined): void {
    this.recordUsage(taskId, 'comment', agent, r);
    if (isUsageLimit(r)) {
      // Give the turn back; it will be retried after the reset.
      this.setThreadCursor(taskId, previousCursor);
      this.pausedUntil = parseResetTime(`${r.text}\n${r.stderr}`, this.now());
      this.log(`사용량 한도 도달. ${this.pausedUntil.toLocaleString()} 까지 대기`);
      return;
    }
    const text = r.text.trim();
    if (r.isError || r.timedOut || !text) {
      this.log(`💬 ${taskId} — ${agent} 코멘트 답변 실패: ${(r.text || r.stderr || '출력 없음').split('\n')[0].slice(0, 120)}`);
      return;
    }
    try {
      this.board.threadPost(agent, taskId, text, item);
      this.notify({ title: `코멘트 · ${taskId} · ${agent}`, body: text.slice(0, 200) });
    } catch {
      // The owner already decided while the reply was being written: keep it in the history only.
      this.board.comment(agent, taskId, text);
    }
    this.commit(`${taskId} ${agent}: 코멘트`);
  }

  private chatPrompt(conv: Conversation, agent: string, mode: ChatMode): string {
    const staff = listAgents(this.paths).map((a) => `${a.name}(${a.description})`).join(', ');
    const where =
      conv.kind === 'meeting' ? `회의실 "${conv.title}"` : conv.kind === 'dm' ? `${conv.members.filter((m) => m !== agent).join(', ')} 와(과)의 DM` : `채널 ${conv.title}`;
    const history = transcript(readMessages(this.paths, conv.id, 40));
    const lines = [
      `[사내 메신저] 당신은 ${agent} 입니다. 지금 ${where} 에 있습니다.`,
    ];
    if (conv.kind === 'meeting') {
      lines.push(
        `회의 안건: ${conv.agenda}`,
        `참석자: ${conv.members.join(', ')} (진행자: ${conv.facilitator})`,
      );
    }
    lines.push('', '최근 대화 (오래된 것 → 최신):', '---', history, '---', '');
    if (mode === 'summary') {
      lines.push(
        '회의를 마칩니다. 당신은 진행자로서 회의록을 작성하세요.',
        '- 최종 출력은 회의록 본문(마크다운) 그대로입니다.',
        '- 구성: ## 결론 / ## 결정 사항 / ## 할 일 (항목마다 제안 담당자) / ## 남은 쟁점',
        '- 대화에 실제로 나온 내용만 씁니다. 합의되지 않은 것은 남은 쟁점으로 둡니다.',
      );
    } else {
      lines.push(
        mode === 'meeting' ? '지금 당신의 발언 차례입니다. 앞사람들의 의견을 보고 이어서 말하세요.' : '이 대화에 답장하세요.',
        '- 최종 출력은 보낼 메시지 본문 그대로입니다. 인사말, 서명, 따옴표 없이 씁니다.',
        '- 대화체로 짧고 구체적으로 씁니다. 보통 2~6문장입니다. 동의만 반복하지 말고 자기 관점(근거, 우려, 대안)을 더합니다.',
        '- 사실 확인이 필요하면 bf task list / bf task show / bf memory show 와 파일 읽기로 확인합니다. 추측은 추측이라고 밝힙니다.',
        '- 메신저에서는 일을 직접 처리하지 않습니다. 실제 작업이 필요하면 사용자에게 "목표로 등록하자"고 제안합니다.',
        `- 다른 직원의 의견이 꼭 필요할 때만 @이름 으로 부릅니다. 직원: ${staff}`,
        '- bf chat post 로 따로 보내지 마세요. 최종 출력이 곧 메시지입니다.',
        '- 덧붙일 말이 없으면 정확히 (패스) 라고만 출력합니다.',
      );
    }
    return lines.join('\n');
  }

  private handleChat(convId: string, agent: string, mode: ChatMode, r: RunResult, due: DueReply | undefined, previousCursor: string | undefined): void {
    fs.appendFileSync(
      path.join(this.paths.company, 'usage.jsonl'),
      JSON.stringify({
        at: this.now().toISOString(),
        task: convId,
        project: null,
        kind: 'chat',
        agent,
        models: r.models,
        turns: r.numTurns,
        duration_ms: r.durationMs,
        cost_usd_estimate: r.costUsd,
        error: r.isError,
      }) + '\n',
      'utf8',
    );
    const conv = getConv(this.paths, convId);

    if (isUsageLimit(r)) {
      // Give the turn back; it will be retried after the reset.
      if (due) {
        if (previousCursor) writeCursor(this.paths, convId, agent, previousCursor);
        else writeCursor(this.paths, convId, agent, '');
      }
      this.pausedUntil = parseResetTime(`${r.text}\n${r.stderr}`, this.now());
      this.log(`사용량 한도 도달. ${this.pausedUntil.toLocaleString()} 까지 대기`);
      return;
    }

    const names = listAgents(this.paths).map((a) => a.name);
    const text = r.text.trim();
    const failed = r.isError || r.timedOut || !text;
    if (failed) this.log(`💬 ${conv.title} — ${agent} 답변 실패: ${(r.text || r.stderr || '출력 없음').split('\n')[0].slice(0, 120)}`);

    if (mode === 'summary') {
      const notes = failed ? '(회의록 작성에 실패했습니다)' : text;
      postMessage(this.paths, convId, agent, notes, { chain: 9, kind: 'summary' });
      const dir = meetingNotesDir(this.paths);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${convId}.md`);
      const header = [
        `# ${conv.title}`,
        '',
        `- 일시: ${new Date(conv.created_at).toLocaleString()}`,
        `- 참석: ${conv.members.join(', ')}`,
        `- 진행: ${conv.facilitator}`,
        '',
        '## 안건',
        '',
        conv.agenda ?? '',
        '',
      ].join('\n');
      fs.writeFileSync(file, `${header}\n${notes}\n\n---\n\n## 대화 기록\n\n${transcript(readMessages(this.paths, convId, 10_000))}\n`, 'utf8');
      conv.status = 'closed';
      conv.notes_file = path.relative(this.paths.company, file).split(path.sep).join('/');
      saveConv(this.paths, conv);
      this.log(`💬 ${conv.title} 회의록 완료`);
      this.notify({ title: `회의록 완료 · ${conv.title}`, body: '웹 화면 메신저에서 확인하세요.' });
      this.commit(`회의록: ${conv.title}`);
      return;
    }

    const passed = text === '(패스)' || text === '패스';
    let posted = null;
    if (!failed && !passed) {
      const chain = mode === 'meeting' ? 1 : (due?.chain ?? 0) + 1;
      posted = postMessage(this.paths, convId, agent, text, { chain, names });
    }

    if (mode === 'meeting') {
      const fresh = getConv(this.paths, convId);
      const queue = (fresh.queue ?? []).filter((n, i) => !(i === 0 && n === agent));
      const used = (fresh.turns_since_owner ?? 0) + 1;
      const participants = fresh.members.filter((m) => names.includes(m));
      const limit = participants.length * this.config.chat.meeting_turns_per_participant;
      // Someone asked a colleague directly: let them answer, within the turn budget.
      for (const m of posted?.mentions ?? []) {
        if (m !== agent && participants.includes(m) && !queue.includes(m) && used + queue.length < limit) queue.push(m);
      }
      fresh.queue = used >= limit ? [] : queue;
      fresh.turns_since_owner = used;
      saveConv(this.paths, fresh);
    }
  }

  // ---- scheduling ----

  /** Console plus company/engine.log, so the history survives closing the window. */
  private defaultLog(line: string): void {
    // One entry per line in the file, so followers (bf watch, the web feed) never see fragments.
    const stamped = `[${this.now().toLocaleString()}] ${line.replace(/\s*\n\s*/g, ' ⏎ ')}`;
    console.log(`[${this.now().toLocaleTimeString()}] ${line}`);
    try {
      fs.appendFileSync(path.join(this.paths.company, 'engine.log'), stamped + '\n', 'utf8');
    } catch {
      // logging must never stop the company
    }
  }

  private onRunEvent(taskId: string, agent: string, ev: RunEvent): void {
    if (ev.kind === 'activity') {
      this.log(`  ${taskId} ${agent} ▸ ${ev.text}`);
      try {
        fs.appendFileSync(
          path.join(this.board.taskDir(taskId), 'activity.log'),
          `${this.now().toISOString()} [${agent}] ${ev.text}\n`,
          'utf8',
        );
      } catch {
        // task folder may be gone if the task was cancelled mid-run
      }
    } else {
      this.onUsage(ev.usage);
    }
  }

  /**
   * Remember the latest subscription usage and stop starting new work once a window passes
   * its ceiling, so the company never eats the allowance the owner needs for personal use.
   */
  private onUsage(usage: UsageSnapshot): void {
    writeFileAtomic(
      path.join(this.paths.company, '.engine-usage.json'),
      JSON.stringify({ at: this.now().toISOString(), ...usage }, null, 2),
    );
    const ceiling = this.config.usage_ceiling as Record<string, number>;
    let until = 0;
    const reasons: string[] = [];
    for (const [name, w] of Object.entries(usage.windows)) {
      const limit = ceiling[name];
      if (limit !== undefined && w.utilization >= limit) {
        until = Math.max(until, w.resetsAt * 1000);
        reasons.push(`${WINDOW_LABEL[name] ?? name} ${Math.round(w.utilization * 100)}% (상한 ${Math.round(limit * 100)}%)`);
      }
    }
    if (until > this.now().getTime() && (!this.pausedUntil || this.pausedUntil.getTime() < until)) {
      this.pausedUntil = new Date(until + 60_000);
      this.log(`사용량 상한 도달: ${reasons.join(', ')}. ${this.pausedUntil.toLocaleString()} 까지 새 업무를 시작하지 않음`);
      this.notify({
        title: '사용량 상한으로 휴식',
        body: `${reasons.join(', ')}\n${this.pausedUntil.toLocaleString()} 에 자동으로 다시 일합니다.`,
      });
    }
  }

  private fireSchedules(): void {
    let due;
    try {
      due = dueSchedules(this.paths, this.now());
    } catch (err) {
      this.log(`정기 업무 설정 오류: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const s of due) {
      const task = this.board.createTask(this.config.owner, {
        title: s.goal.split('\n')[0].slice(0, 80),
        description: `${s.goal}\n\n(정기 업무 ${s.id}: ${s.cron})`,
        assignee: this.config.ceo,
        doneWhen: DEFAULT_GOAL_DONE_WHEN,
        project: s.project ?? null,
        priority: s.priority ?? 0,
        parent: null,
      });
      this.log(`정기 업무 ${s.id} → 목표 ${task.id} 등록`);
    }
  }

  private candidates(): { task: Task; kind: RunKind }[] {
    const busyWorkspaces = new Set([...this.active.values()].map((a) => a.workspace).filter(Boolean));
    const reviews = this.board
      .list()
      .filter((t) => t.status === 'review' && (this.reviewMisses.get(t.id) ?? 0) < this.config.max_attempts)
      .map((task) => ({ task, kind: 'review' as const }));
    const work = this.board.runnable().map((task) => ({ task, kind: 'work' as const }));
    // Reviews first: they unblock waiting parents and cost little.
    return [...reviews, ...work].filter(({ task, kind }) => {
      if (this.active.has(task.id) || this.missingAgent.has(`${kind}:${task.id}`)) return false;
      if (kind === 'work' && task.workspace && busyWorkspaces.has(task.workspace)) return false;
      return true;
    });
  }

  private launch(task: Task, kind: RunKind): void {
    const agentName = kind === 'review' ? this.config.reviewer : task.assignee;
    const agent = getAgent(this.paths, agentName);
    if (!agent) {
      this.log(`${task.id} 직원 정의가 없습니다: ${agentName} — 건너뜀`);
      this.board.comment('engine', task.id, `직원 정의가 없어 실행하지 못함: ${agentName}`);
      this.missingAgent.add(`${kind}:${task.id}`);
      return;
    }
    if (kind === 'work') this.board.start(task.id);
    this.log(`${task.id} ${kind === 'review' ? '검수' : '실행'} 시작 → ${agent.name}: ${task.title}`);

    const spec = this.buildSpec(task, kind, agent);
    spec.onEvent = (ev) => this.onRunEvent(task.id, agent.name, ev);
    const entry: ActiveRun = {
      taskId: task.id,
      kind,
      agent: agent.name,
      workspace: task.workspace,
      startedAt: this.now().toISOString(),
      promise: Promise.resolve(),
    };
    entry.promise = this.run(spec)
      .then((result) => this.handleResult(task.id, kind, agent, result))
      .catch((err) => {
        this.log(`${task.id} 처리 중 오류: ${err instanceof Error ? err.stack : String(err)}`);
      })
      .finally(() => {
        this.active.delete(task.id);
      });
    this.active.set(task.id, entry);
  }

  private buildSpec(task: Task, kind: RunKind, agent: AgentInfo): RunSpec {
    const taskDir = this.board.taskDir(task.id);
    const workspaceDir = task.workspace ? path.join(this.paths.workspaces, task.workspace) : null;
    if (workspaceDir) fs.mkdirSync(workspaceDir, { recursive: true });

    // Employees change only their own task folder and workspace; reviewers change nothing.
    const access: Access =
      kind === 'review'
        ? { write: [], read: [taskDir, ...(workspaceDir ? [workspaceDir] : []), this.paths.board, this.paths.memory] }
        : { write: [taskDir, ...(workspaceDir ? [workspaceDir] : [])], read: [this.paths.board, this.paths.memory] };

    const agentsFile = path.join(this.paths.company, '.run', `${task.id}-${kind}-agents.json`);
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    const def: Record<string, unknown> = { description: agent.description || agent.name, prompt: agent.prompt };
    const tools = agentToolList(agent);
    if (tools) def.tools = tools;
    if (agent.model) def.model = agent.model;
    writeFileAtomic(agentsFile, JSON.stringify({ [agent.name]: def }, null, 2));

    return {
      command: this.config.claude_command,
      agent,
      agentsFile,
      prompt: kind === 'review' ? this.reviewPrompt(task) : this.workPrompt(task, workspaceDir),
      cwd: taskDir,
      access,
      // Approved grants apply to the assignee's own work, never to the reviewer.
      grants: kind === 'work' ? (task.grants ?? []) : [],
      handbook: fs.existsSync(this.paths.handbook) ? this.paths.handbook : null,
      maxTurns: this.config.max_turns,
      timeoutMs: this.config.run_timeout_minutes * 60_000,
      binDir: this.paths.bin,
      env: {
        BF_ROOT: this.paths.root,
        BF_COMPANY: this.paths.company,
        BF_WORKSPACES: this.paths.workspaces,
        BF_ACTOR: agent.name,
        BF_TASK: task.id,
      },
    };
  }

  private workPrompt(task: Task, workspaceDir: string | null): string {
    const lines = [
      `업무 ${task.id} 를 수행하세요. 당신은 담당자 ${task.assignee} 입니다.`,
      `- 현재 폴더가 이 업무의 폴더입니다. 결과물은 output/ 에 저장하세요.`,
      `- 먼저 \`bf task show ${task.id}\` 로 지시서, 하위 업무, 이력을 확인하세요.`,
    ];
    if (workspaceDir) lines.push(`- 작업 공간: ${workspaceDir}`);
    const kids = this.board.children(task.id);
    const questions = kids.filter((k) => k.status === 'blocked' && !k.approval && k.ask_to === task.assignee);
    if (questions.length > 0) {
      lines.push(
        `- 하위 업무 ${questions.map((k) => k.id).join(', ')} 에서 당신에게 질문이 왔습니다. \`bf task show <번호>\` 로 질문을 읽고 \`bf task answer <번호> "<답>"\` 으로 답하세요. 당신도 모르는 사용자 판단이 필요하면 \`bf task ask ${task.id} "<질문>"\` 으로 위에 물으세요.`,
      );
    }
    const ownerOpen = kids.filter((k) => this.board.isOwnerTask(k) && !isTerminal(k.status));
    if (ownerOpen.length > 0) {
      lines.push(
        `- 사용자 업무 ${ownerOpen.map((k) => k.id).join(', ')} 는 사용자가 처리 중입니다. 기다리지 말고 그것 없이 할 수 있는 일을 진행하세요. 그 결과가 꼭 필요한 업무는 --depends <번호> 로 걸어 두면 끝난 뒤 시작됩니다.`,
      );
    }
    if (kids.length > 0 && kids.every((k) => isTerminal(k.status))) {
      lines.push(
        `- 맡긴 하위 업무가 모두 끝났습니다. 각 하위 업무의 결과물(${this.paths.board}${path.sep}<번호>${path.sep}output)과 이력을 확인해 취합하세요.`,
      );
    }
    if (task.attempts > 1 || task.rejections > 0) {
      lines.push('- 이 업무는 이전에 반려되었거나 보고 없이 끝난 적이 있습니다. 이력의 사유를 반드시 반영하세요.');
    }
    lines.push(
      `- 끝나면 반드시 \`bf task done ${task.id} --summary "<한 일과 결과물 위치>"\` 로 보고하세요.`,
      `- 판단에 꼭 필요한 정보가 없으면 \`bf task ask ${task.id} "<질문>"\` 후 실행을 마치세요.`,
    );
    return lines.join('\n');
  }

  private reviewPrompt(task: Task): string {
    return [
      `업무 ${task.id} (담당 ${task.assignee}) 의 결과물을 검수하세요. 당신은 검수자 ${this.config.reviewer} 입니다.`,
      `- \`bf task show ${task.id}\` 로 완료 조건과 완료 보고를 확인하고, output/ 의 결과물을 직접 열어 확인하세요.`,
      `- 완료 조건을 모두 충족하면 \`bf task pass ${task.id} --note "<확인한 내용>"\``,
      `- 하나라도 미달이면 \`bf task reject ${task.id} "<무엇이 왜 부족하고 어떻게 고쳐야 하는지>"\``,
      `- 결과물을 직접 고치지 마세요. 판정만 합니다.`,
    ].join('\n');
  }

  // ---- results ----

  private handleResult(taskId: string, kind: RunKind, agent: AgentInfo, r: RunResult): void {
    this.recordUsage(taskId, kind, agent.name, r);
    const after = this.board.read(taskId).task;
    const summary = `${kind === 'review' ? '검수' : '실행'} 종료 (${r.numTurns}턴, ${Math.round(r.durationMs / 1000)}초${r.sessionId ? `, 세션 ${r.sessionId}` : ''})`;

    if (isUsageLimit(r)) {
      this.pausedUntil = parseResetTime(`${r.text}\n${r.stderr}`, this.now());
      if (kind === 'work') this.board.requeue(taskId, `사용량 한도: ${r.text}`);
      this.log(`사용량 한도 도달. ${this.pausedUntil.toLocaleString()} 까지 대기`);
      this.notify({ title: '사용량 한도로 휴식', body: `${this.pausedUntil.toLocaleString()} 에 자동으로 다시 일합니다.` });
      this.commit(`${taskId} 사용량 한도`);
      return;
    }
    if (r.apiErrorStatus === 401 || r.apiErrorStatus === 403) {
      if (kind === 'work') this.board.requeue(taskId, `인증 오류: ${r.text}`);
      this.halt(`Claude 인증 오류 (${r.apiErrorStatus}): ${r.text}. 'claude' 를 직접 실행해 로그인 상태를 확인하세요.`);
      return;
    }

    if (r.denials.length > 0) {
      const shown = r.denials.slice(0, 5).map((d) => truncate(d.replace(/\s+/g, ' '), 160));
      this.board.comment('engine', taskId, `권한 거부 ${r.denials.length}건: ${shown.join(' | ')}`);
    }

    if (kind === 'work') {
      if (after.status === 'running') {
        const why = r.timedOut ? '시간 초과' : r.isError ? `오류: ${r.text || r.stderr}` : `보고 없이 종료: ${r.text}`;
        const t = this.board.finishRun(taskId, `${summary} — ${truncate(why, 1500)}`);
        this.log(`${taskId} → ${STATUS_LABEL[t.status]} (${why.split('\n')[0].slice(0, 80)})`);
      } else {
        this.board.comment('engine', taskId, `${summary} — ${truncate(r.text, 1500)}`);
        this.log(`${taskId} → ${STATUS_LABEL[after.status]}`);
      }
    } else {
      if (after.status === 'review') {
        const misses = (this.reviewMisses.get(taskId) ?? 0) + 1;
        this.reviewMisses.set(taskId, misses);
        this.board.comment('engine', taskId, `${summary} — 판정 없이 종료 (${misses}/${this.config.max_attempts}): ${truncate(r.text, 800)}`);
        this.log(`${taskId} 검수 판정 없음 (${misses}/${this.config.max_attempts})`);
      } else {
        this.reviewMisses.delete(taskId);
        this.log(`${taskId} 검수 → ${STATUS_LABEL[after.status]}`);
      }
    }

    // Check before committing, or the commit would hide a tampered staff file.
    if (!this.checkIntegrity(taskId, agent.name)) return;
    this.notifyOwner();
    this.commit(`${taskId} ${agent.name}: ${STATUS_LABEL[this.board.read(taskId).task.status]}`);
  }

  private recordUsage(taskId: string, kind: RunKind | 'comment', agent: string, r: RunResult): void {
    const task = this.board.read(taskId).task;
    const entry = {
      at: this.now().toISOString(),
      task: taskId,
      project: task.project,
      kind,
      agent,
      models: r.models,
      turns: r.numTurns,
      duration_ms: r.durationMs,
      cost_usd_estimate: r.costUsd,
      error: r.isError,
    };
    fs.appendFileSync(path.join(this.paths.company, 'usage.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  }

  private commit(message: string): void {
    commitCompany(this.paths, message);
  }

  private snapshotSystem(): string | null {
    return systemStatus(this.paths, SYSTEM_AREAS);
  }

  /**
   * Tripwire: shell commands can't be fully path-scoped, so after every run check that
   * neither the system code nor the staff roster changed. Returns false (and halts) if either did.
   */
  private checkIntegrity(taskId: string, agent: string): boolean {
    const staff = staffChanges(this.paths);
    if (staff) {
      this.halt(
        `${taskId} (${agent}) 실행 후 직원 명부가 승인 없이 변경되었습니다. company 폴더에서 'git status' 로 확인하세요:\n${staff}`,
      );
      return false;
    }
    if (this.systemSnapshot === null) return true;
    const current = this.snapshotSystem();
    if (current !== null && current !== this.systemSnapshot) {
      this.halt(`${taskId} (${agent}) 실행 후 시스템 영역이 변경되었습니다. 'git status' 로 확인하세요:\n${current}`);
      return false;
    }
    return true;
  }

  private halt(reason: string): void {
    this.haltReason = reason;
    this.haltedAt = this.now();
    this.log(`!!! ${reason}`);
    this.notify({ title: '엔진 정지 — 확인 필요', body: reason.slice(0, 300) });
  }

  /**
   * Watchdog: once a halt has waited auto_resume_minutes (doubling for each resume in a row,
   * capped at 6 hours), switch back on by itself. Returns true when it resumed.
   */
  private autoResume(): boolean {
    const base = this.config.watchdog.auto_resume_minutes;
    if (!base || !this.haltedAt || this.runningCount > 0) return false;
    const waitMinutes = Math.min(base * 2 ** this.autoResumes, 360);
    if (this.now().getTime() - this.haltedAt.getTime() < waitMinutes * 60_000) return false;
    const reason = this.haltReason;
    this.haltReason = null;
    this.haltedAt = null;
    this.autoResumes++;
    this.recover();
    this.log(`감시: 정지 ${waitMinutes}분 경과, 자동으로 다시 가동 (연속 ${this.autoResumes}회째)`);
    this.notify({ title: '엔진 자동 재가동', body: `정지 원인: ${(reason ?? '').slice(0, 250)}` });
    return true;
  }

  /** Liveness for `bf engine-check`: the loop rewrites this every pass, even while off or halted. */
  private heartbeat(): void {
    try {
      writeFileAtomic(
        path.join(this.paths.company, '.engine-heartbeat.json'),
        JSON.stringify({ pid: process.pid, at: this.now().toISOString(), enabled: this.enabled, halted: this.haltReason }),
      );
    } catch {
      // a missed beat only matters if it keeps happening
    }
  }

  /** Announce anything newly waiting on the owner (approvals, questions, finished goals). */
  private notifyOwner(): void {
    try {
      this.ownerNotifier.check(this.board);
    } catch (err) {
      this.log(`알림 확인 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
