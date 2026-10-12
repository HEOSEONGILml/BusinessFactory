import fs from 'node:fs';
import path from 'node:path';
import { getAgent, listAgents } from './agents.ts';
import type { AgentInfo } from './agents.ts';
import { Board, BoardError, DEFAULT_GOAL_DONE_WHEN, isTerminal, lastLogEntry, originThreadTask, STATUS_LABEL } from './board.ts';
import type { Task } from './board.ts';
import type { Config } from './config.ts';
import { writeFileAtomic } from './fsutil.ts';
import { commitCompany } from './git.ts';
import type { Paths } from './paths.ts';
import { agentToolList, isUsageLimit, parseResetTime, runAgent } from './runner.ts';
import {
  channelForTask,
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
import { charterOf, journalFile, missionExists, missionFile, MissionLoop, readMission } from './missions.ts';
import { WINDOW_LABEL } from './stream.ts';
import { ensureWorktree, removeWorktree, usesWorktrees } from './worktree.ts';
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
  private readonly notify: Sender;
  private readonly ownerNotifier: OwnerNotifier;
  private readonly chatActive = new Map<string, ChatRun>();
  /** Assignees replying to the owner's comments on inbox items, by task id. */
  private readonly threadActive = new Map<string, ChatRun>();
  /** Failed replies in a row, by task id; retried a few times before telling the owner. */
  private readonly threadFailures = new Map<string, number>();
  /** The on/off switch. Off: no new runs start; runs in progress finish. */
  private enabled: boolean;
  /** Mission steps: settles finished ones, creates the next, sends mission reports (docs/MISSIONS.md). */
  private readonly missions: MissionLoop;

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
    this.missions = new MissionLoop({ board: this.board, paths, config, now: this.now, log: this.log, notify: this.notify });
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
    this.reportOrigins();
    this.announceWork();
    this.cleanWorktrees();
    if (!this.enabled) return;
    this.fireSchedules();
    try {
      this.missions.tick();
    } catch (e) {
      this.log(`미션 처리 오류: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.pausedUntil) {
      if (this.now() < this.pausedUntil) return;
      this.log('사용량 한도 대기 종료, 재개');
      this.pausedUntil = null;
    }

    for (const { task, kind } of this.candidates()) {
      if (this.active.size >= this.config.max_concurrency) break;
      // Re-check: an earlier launch in this same pass may have taken the workspace.
      if (kind === 'work' && this.exclusiveWorkspace(task) && [...this.active.values()].some((a) => a.workspace === task.workspace)) {
        continue;
      }
      try {
        this.launch(task, kind);
      } catch (e) {
        // The task changed since candidates() read it (e.g. the owner cancelled it): skip it.
        if (!(e instanceof BoardError)) throw e;
        this.log(`${task.id} 시작 건너뜀: ${e.message}`);
      }
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
      try {
        this.tick();
      } catch (e) {
        // One bad pass must not take the whole company down; log it and try again next poll.
        this.log(`!!! 엔진 처리 중 오류 (다음 주기에 다시 시도): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      }
      this.heartbeat();
      await sleep(this.config.poll_seconds * 1000, signal);
    }
    if (this.active.size > 0) this.log(`진행 중인 실행 ${this.active.size}건이 끝나기를 기다립니다...`);
    await this.drain();
    if (this.haltReason) this.log(`엔진 정지: ${this.haltReason}`);
  }

  // ---- worktrees ----

  /** A task that must have its workspace to itself (no worktree for it). */
  private exclusiveWorkspace(task: Task): boolean {
    return task.workspace !== null && !(this.config.worktrees && usesWorktrees(this.paths, task.workspace));
  }

  /** Tasks that ended no longer need their worktree; their branch goes too once merged. */
  private cleanWorktrees(): void {
    for (const t of this.board.list()) {
      if (!t.worktree || t.worktree.removed || !isTerminal(t.status) || this.active.has(t.id)) continue;
      try {
        removeWorktree(this.paths, t);
        this.board.setWorktree(t.id, { ...t.worktree, removed: true });
        this.log(`${t.id} worktree 정리 (${t.worktree.branch}${t.status === 'done' ? ', 병합됨' : ', 브랜치는 보관'})`);
      } catch (e) {
        this.log(`${t.id} worktree 정리 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** The folder the employee works in: the task's own worktree when it has one, else the workspace. */
  private workDir(task: Task, kind: RunKind): string | null {
    if (!task.workspace) return null;
    const main = path.join(this.paths.workspaces, task.workspace);
    if (kind === 'review') return task.worktree && !task.worktree.removed && fs.existsSync(task.worktree.path) ? task.worktree.path : main;
    if (!this.config.worktrees || !usesWorktrees(this.paths, task.workspace)) return main;
    try {
      const wt = ensureWorktree(this.paths, task);
      if (!wt) return main;
      if (task.worktree?.path !== wt.path || task.worktree?.removed) {
        this.board.setWorktree(task.id, wt);
        task.worktree = wt;
      }
      return wt.path;
    } catch (e) {
      this.log(`${task.id} worktree 를 만들지 못해 작업 공간에서 직접 실행: ${e instanceof Error ? e.message : String(e)}`);
      return main;
    }
  }

  // ---- messenger and meetings ----

  /** Work asked for in the messenger: once it ends, say how it went in that conversation. */
  private reportOrigins(): void {
    for (const t of this.board.list()) {
      if (!t.origin || t.origin.reported || !isTerminal(t.status)) continue;
      try {
        const log = this.board.readLog(t.id);
        const text =
          t.status === 'done'
            ? `✅ **${t.id} 완료** — ${t.title}\n\n${truncate(lastLogEntry(log, '완료보고') || '(요약 없음)', 1500)}\n\n결과물: 업무 ${t.id} 의 output/`
            : t.status === 'failed'
              ? `❌ **${t.id} 실패** — ${t.title}\n\n${truncate(lastLogEntry(log, '실패') || '(사유 없음)', 1000)}\n\n처리할 일에서 확인해 주세요.`
              : `🚫 **${t.id} 취소됨** — ${t.title}`;
        const source = originThreadTask(t.origin);
        if (source) {
          // Shown in the thread: the result counts as seen. Settled thread: keep it in the inbox too.
          const shown = this.reportToThread(source, t, text);
          this.board.markOriginReported(t.id, shown);
          continue;
        }
        const conv = getConv(this.paths, t.origin.conv);
        // A DM only takes its two members; fall back to whoever took the request there.
        const from = conv.kind === 'dm' && !conv.members.includes(t.assignee) ? t.created_by : t.assignee;
        postMessage(this.paths, conv.id, from, text, { chain: this.config.chat.max_chain, kind: 'system' });
        this.log(`💬 ${conv.title} ← ${t.id} 결과 보고 (${STATUS_LABEL[t.status]})`);
      } catch (e) {
        this.log(`${t.id} 결과를 대화에 올리지 못함: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.board.markOriginReported(t.id);
    }
  }

  /**
   * Every task that ends is shared briefly in its channel (mission → #m001, project → #project,
   * otherwise #general). Mission steps are covered by the mission journal, which is shared too.
   * Tasks that ended before this feature existed (company/chat/.announce-since) are skipped.
   */
  private announceWork(): void {
    const since = this.announceSince();
    for (const t of this.board.list()) {
      if (t.announced || !isTerminal(t.status) || t.updated_at < since) continue;
      try {
        const step = t.parent === null && !!t.mission;
        const conv = step ? null : channelForTask(this.paths, t);
        // Already answered in this very conversation by reportOrigins.
        if (conv && t.origin?.conv !== conv.id) {
          const log = this.board.readLog(t.id);
          const n = t.parent === null ? 800 : 300;
          const head = `${t.id}${t.parent ? ` (${t.parent} 하위)` : ''} — ${t.title} · ${t.assignee}`;
          const text =
            t.status === 'done'
              ? `✅ **완료** ${head}\n\n${truncate(lastLogEntry(log, '완료보고') || '(요약 없음)', n)}`
              : t.status === 'failed'
                ? `❌ **실패** ${head}\n\n${truncate(lastLogEntry(log, '실패') || '(사유 없음)', n)}`
                : `🚫 **취소** ${head}`;
          const from = t.assignee === this.config.owner ? t.created_by : t.assignee;
          postMessage(this.paths, conv.id, from, text, { chain: this.config.chat.max_chain, kind: 'system' });
        }
      } catch (e) {
        this.log(`${t.id} 결과를 채널에 공유하지 못함: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.board.markAnnounced(t.id);
    }
  }

  private announceSinceCache: string | null = null;

  private announceSince(): string {
    if (this.announceSinceCache) return this.announceSinceCache;
    const file = path.join(this.paths.company, 'chat', '.announce-since');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, this.now().toISOString() + '\n');
    }
    this.announceSinceCache = fs.readFileSync(file, 'utf8').trim();
    return this.announceSinceCache;
  }

  /** A request made in a comment thread: answer there, or in the task's history once the thread is settled. */
  private reportToThread(sourceId: string, t: Task, text: string): boolean {
    const source = this.board.read(sourceId).task;
    const from = this.board.responder(source);
    let shown = true;
    try {
      this.board.threadPost(from, sourceId, text);
      this.notify({ title: `코멘트 · ${sourceId} · ${from}`, body: text.slice(0, 200) });
    } catch {
      this.board.comment(from, sourceId, text);
      shown = false;
    }
    this.log(`💬 ${sourceId} 코멘트 ← ${t.id} 결과 보고 (${STATUS_LABEL[t.status]})`);
    return shown;
  }

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
    // Read-only mode keeps workspaces (secrets) out of the messenger; full_access adds them in talkSpec.
    return this.talkSpec(agent, 'chat', this.chatPrompt(conv, agent.name, mode), chatDir, [chatDir, this.paths.board, this.paths.memory], { BF_CHAT: conv.id });
  }

  /**
   * Messenger and comment runs. With full_access they run exactly like work runs: every tool the
   * employee has, no permission checks, the whole company and its workspaces reachable, and the
   * work-run turn/time limits. Without it, talking stays read-only (no edits, no shell beyond bf).
   */
  private talkSpec(agent: AgentInfo, label: string, prompt: string, cwd: string, read: string[], env: Record<string, string>): RunSpec {
    const full = this.config.full_access;
    const baseTools = agent.tools.length ? agent.tools : ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];
    const talker: AgentInfo = full
      ? agent
      : {
          ...agent,
          tools: baseTools.filter((t) => !EDIT_TOOLS.has(t)),
          permissions: agent.permissions.filter((p) => /^(WebSearch|WebFetch)\b/.test(p)),
        };
    const dirs = full ? [...new Set([...read, this.paths.workspaces, this.paths.root])] : read;
    const agentsFile = path.join(this.paths.company, '.run', `${label}-${agent.name}.json`);
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    const def: Record<string, unknown> = { description: agent.description || agent.name, prompt: agent.prompt };
    const tools = agentToolList(talker);
    if (tools) def.tools = tools;
    const model = agent.model ?? this.config.default_model;
    if (model) def.model = model;
    writeFileAtomic(agentsFile, JSON.stringify({ [agent.name]: def }, null, 2));
    return {
      command: this.config.claude_command,
      agent: talker,
      agentsFile,
      prompt,
      cwd,
      access: full ? { write: dirs, read: [] } : { write: [], read },
      grants: [],
      fullAccess: full,
      handbook: fs.existsSync(this.paths.handbook) ? this.paths.handbook : null,
      maxTurns: full ? Math.max(this.config.chat.max_turns, this.config.max_turns) : this.config.chat.max_turns,
      timeoutMs: (full ? Math.max(this.config.chat.timeout_minutes, this.config.run_timeout_minutes) : this.config.chat.timeout_minutes) * 60_000,
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
      const entries = this.board.openThread(task.id);
      const last = entries.at(-1);
      if (!last || last.from !== this.config.owner || last.n <= (cursors[task.id] ?? 0)) continue;
      if (!this.board.canComment(task, last.item)) continue;
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
    const spec = this.talkSpec(agent, 'thread', this.threadPrompt(task, agent.name, item), taskDir, read, { BF_THREAD: task.id });
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
        : this.board.awaitsOwner(task, item)
          ? `이 목표는 ${STATUS_LABEL[task.status]} 상태로 끝났고, 사용자가 결과를 확인하는 중입니다. 결과물은 output/ 에 있습니다.`
          : [
              `이 업무는 아직 진행 중입니다 (상태: ${STATUS_LABEL[task.status]}, 담당 ${task.assignee}${this.active.has(task.id) ? ', 지금 실행 중' : ''}). 사용자가 진행 중인 업무에 메모·지시를 남긴 것입니다.`,
              `이 코멘트는 담당자의 다음 실행 지시에 자동으로 들어가고, 지금 실행 중인 담당자도 완료 보고 전에 확인합니다. 실행 중인 작업과 겹치지 않게 이 업무 자체의 작업(파일 수정, 하위 업무 생성 등)은 하지 말고, 이해한 내용과 어떻게 반영될지를 답하세요.`,
            ].join('\n');
    const thread = this.board
      .openThread(task.id, item)
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
      `- 사실 확인이 필요하면 \`bf task show ${task.id}\` 와 파일 읽기${this.config.full_access ? ', 셸 명령(git log 등)' : ''}로 직접 확인합니다. 추측은 추측이라고 밝힙니다.`,
      ...this.directWorkLines(),
      `- **사용자가 일을 부탁하거나 지시하면 (이 업무가 끝난 뒤라도)** ${this.config.full_access ? "바로 끝낼 수 없는 일은 " : ""}그 자리에서 업무로 등록합니다. 버튼을 누르라거나 새 목표를 따로 만들라고 되돌려 보내지 않습니다:`,
      '  `bf chat task --title "<할 일 한 문장>" --desc "<배경, 요청 내용, 참고 경로>" --done-when "<검수자가 파일만 보고 판정할 조건>" [--to <직원>] [--workspace <작업 공간>] [--no-review]`',
      '  - 담당: 내 직무면 생략(자신), 다른 직무면 --to <직원>, 여러 단계·여러 직무가 필요한 큰 일이면 --to ceo. 작업 공간은 생략하면 이 업무의 것을 씁니다.',
      '  - 등록했으면 코멘트에 업무 번호와 무엇을 하기로 했는지 한두 문장으로 알립니다. 끝나면 결과가 이 코멘트에 자동으로 올라온다고 덧붙입니다.',
      '  - 사용자가 부탁하지 않은 일은 등록하지 않습니다. 필요해 보이면 제안하고, 사용자가 하자고 하면 등록합니다. 요청이 모호해 방향이 갈릴 때만 되묻습니다.',
      '- 질문에 대한 답변 확정, 결재 승인, 결과 확인은 사용자가 화면의 버튼으로 합니다. 이 업무의 상태를 바꾸는 bf 명령(done, ask, answer 등)은 쓰지 마세요.',
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
      const why = (r.text || r.stderr || '출력 없음').split('\n')[0].slice(0, 120);
      const tries = (this.threadFailures.get(taskId) ?? 0) + 1;
      if (tries < 3) {
        // Give the turn back so the next pass retries it (e.g. the run was killed by a restart).
        // Otherwise the card says "곧 확인합니다" forever and nobody answers.
        this.threadFailures.set(taskId, tries);
        this.setThreadCursor(taskId, previousCursor);
        this.log(`💬 ${taskId} — ${agent} 코멘트 답변 실패 (${tries}/3, 다시 시도): ${why}`);
      } else {
        this.threadFailures.delete(taskId);
        this.log(`💬 ${taskId} — ${agent} 코멘트 답변 실패 (포기): ${why}`);
        const note = `⚠️ [엔진] ${agent} 의 답변 작성이 3번 연속 실패했습니다 (${why}). 코멘트를 다시 달면 다시 시도합니다.`;
        try {
          // Posted under the responder's name: only the owner and the responder may comment here.
          this.board.threadPost(agent, taskId, note, item);
        } catch {
          this.board.comment('engine', taskId, note);
        }
        this.commit(`${taskId} engine: 코멘트 답변 실패`);
      }
      return;
    }
    this.threadFailures.delete(taskId);
    try {
      this.board.threadPost(agent, taskId, text, item);
      this.notify({ title: `코멘트 · ${taskId} · ${agent}`, body: text.slice(0, 200) });
    } catch {
      // The owner already decided while the reply was being written: keep it in the history only.
      this.board.comment(agent, taskId, text);
    }
    this.commit(`${taskId} ${agent}: 코멘트`);
  }

  /** With full_access, messenger and comment runs may do the work themselves. */
  private directWorkLines(): string[] {
    if (!this.config.full_access) return [];
    return [
      '- 당신은 이 대화에서도 업무 실행과 같은 권한을 가집니다: 모든 도구와 셸 명령, 회사 폴더와 모든 작업 공간(' + this.paths.workspaces + ')을 읽고 고칠 수 있습니다. 권한이 막혀서 못 한다고 답하지 않습니다.',
      '- 확인·조회·짧은 수정처럼 몇 분 안에 끝나는 일은 직접 하고, 무엇을 했는지(바꾼 파일, 커밋)를 답에 적습니다. 결재 대상(돈, 외부 공개, 계정, 삭제)은 직접 하지 않고 업무로 등록해 결재를 받습니다.',
      '- 여러 단계이거나 오래 걸리거나 검수가 필요한 일은 직접 하지 말고 아래처럼 업무로 등록합니다(진행·검수 기록을 남기기 위해).',
    ];
  }

  /**
   * Meeting turns: passing is the default, and nobody plans around a direction the owner
   * hasn't confirmed. The facilitator speaks first and calls in only the people needed.
   */
  private meetingLines(conv: Conversation, agent: string): string[] {
    const others = conv.members.filter((m) => m !== agent && m !== this.config.owner);
    const lines = [
      '- **기본은 (패스)입니다.** 다음 중 하나가 있을 때만 발언합니다: (1) 대화에 아직 없는 새 사실, (2) 앞 의견에 대한 반대 근거나 빠진 위험, (3) 사용자가 당신에게 한 질문이나 당신 직무에 대한 질문의 직접 답. 앞사람과 같은 취지이거나 동의·보충뿐이면 (패스)합니다. 모두가 돌아가며 발언할 필요는 없습니다.',
      '- **사용자가 아직 정하지(컨펌하지) 않은 방향을 확정된 것처럼 다루지 않습니다.** 그런 방향이 있으면 선택지와 근거·위험만 제시하고, 그 방향을 전제로 한 역할 분담, 담당 자원, 완료 조건, 채용 계획, "하자고 하시면 업무로 등록할게요" 같은 제안은 하지 않습니다. 실행 계획은 사용자가 방향을 정한 뒤에 논의합니다.',
    ];
    if (agent === conv.facilitator) {
      lines.push(
        `- 당신은 진행자라 가장 먼저 발언합니다. 사용자 발언에 답하고, 다른 참석자(${others.join(', ') || '없음'})의 의견이 꼭 필요할 때만 그 사람을 @이름 으로 지명합니다. 지명하지 않은 참석자는 발언하지 않습니다. 당신 혼자 답할 수 있으면 아무도 지명하지 않습니다.`,
        '- 사용자가 결정해야 할 것이 있으면 선택지를 정리해 사용자에게 묻고 멈춥니다.',
      );
    }
    return lines;
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
        '- 구성: ## 결론 / ## 결정 사항 / ## 할 일 (항목마다 담당자) / ## 남은 쟁점',
        '- 대화에 실제로 나온 내용만 씁니다. 합의되지 않은 것과 사용자가 컨펌하지 않은 방향은 결정 사항이 아니라 남은 쟁점으로 둡니다.',
        '- 회의에서 합의된 할 일은 회의록을 쓰기 전에 항목마다 `bf chat task --to <담당자> --title "<할 일>" --desc "<배경과 회의 결론>" --done-when "<검수자가 파일만 보고 판정할 조건>"` 으로 업무를 등록하고, 회의록의 할 일 항목 옆에 업무 번호(T0123)를 적습니다. 결과는 끝나면 이 회의실에 올라옵니다.',
        '- 합의되지 않았거나, 사용자가 컨펌하지 않은 방향을 전제로 하거나, 사용자가 하지 말자고 한 일은 등록하지 않습니다. 여러 단계가 필요한 큰 일은 --to ceo 로 하나만 등록합니다.',
      );
    } else {
      lines.push(
        mode === 'meeting' ? '지금 당신의 발언 차례입니다. 다만 할 말이 꼭 있을 때만 발언합니다.' : '이 대화에 답장하세요.',
        ...(mode === 'meeting' ? this.meetingLines(conv, agent) : []),
        '- 최종 출력은 보낼 메시지 본문 그대로입니다. 인사말, 서명, 따옴표 없이 씁니다.',
        mode === 'meeting'
          ? '- 발언한다면 대화체로 짧고 구체적으로 씁니다. 보통 2~5문장입니다.'
          : '- 대화체로 짧고 구체적으로 씁니다. 보통 2~6문장입니다. 동의만 반복하지 말고 자기 관점(근거, 우려, 대안)을 더합니다.',
        `- 사실 확인이 필요하면 bf task list / bf task show / bf memory show 와 파일 읽기${this.config.full_access ? ', 셸 명령(git log 등)' : ''}로 직접 확인합니다. 추측은 추측이라고 밝힙니다.`,
        ...this.directWorkLines(),
        this.config.full_access
          ? '- **사용자가 일을 부탁하거나 지시했는데 바로 끝낼 수 없는 일이면** 그 자리에서 업무로 등록합니다:'
          : '- 메신저에서는 파일을 고치거나 작업을 직접 하지 않습니다. 대신 **사용자가 일을 부탁하거나 지시하면** 그 자리에서 업무로 등록합니다:',
        '  `bf chat task --title "<할 일 한 문장>" --desc "<배경, 요청 내용, 참고 경로>" --done-when "<검수자가 파일만 보고 판정할 조건>" [--to <직원>] [--workspace <작업 공간>] [--no-review]`',
        '  - 담당: 내 직무면 생략(자신), 다른 직무면 --to <직원>, 여러 단계·여러 직무가 필요한 큰 일이면 --to ceo.',
        '  - 문구 수정처럼 작고 확인이 쉬운 일만 --no-review 를 붙입니다. 코드·작업 공간을 고치는 일은 --workspace 를 지정합니다.',
        '  - 등록했으면 답장에 업무 번호와 무엇을 하기로 했는지 한두 문장으로 알립니다. 끝나면 결과가 이 대화에 자동으로 올라온다고 덧붙입니다.',
        '  - 사용자가 부탁하지 않은 일은 등록하지 않습니다. 필요해 보이면 제안만 하고, 사용자가 하자고 하면 등록합니다. 요청이 모호하면 등록하기 전에 짧게 되묻습니다.',
        `- 다른 직원의 의견이 꼭 필요할 때만 @이름 으로 부릅니다. 직원: ${staff}`,
        '- bf chat post 로 따로 보내지 마세요. 최종 출력이 곧 메시지입니다.',
        mode === 'meeting' ? '- 발언할 조건에 해당하지 않으면 정확히 (패스) 라고만 출력합니다.' : '- 덧붙일 말이 없으면 정확히 (패스) 라고만 출력합니다.',
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
    const work = this.orderWork(this.board.runnable()).map((task) => ({ task, kind: 'work' as const }));
    // Reviews first: they unblock waiting parents and cost little.
    return [...reviews, ...work].filter(({ task, kind }) => {
      if (this.active.has(task.id) || this.missingAgent.has(`${kind}:${task.id}`)) return false;
      if (kind === 'work' && task.workspace && busyWorkspaces.has(task.workspace) && this.exclusiveWorkspace(task)) return false;
      return true;
    });
  }

  /**
   * The owner's own goals before mission work; mission work by how little its mission used in
   * 7 days (per weight), held back for paused or over-budget missions and capped at the mission slots.
   */
  private orderWork(runnable: Task[]): Task[] {
    const isMission = (t: Task) => !!t.mission && missionExists(this.paths, t.mission);
    const mission = runnable.filter(isMission);
    if (mission.length === 0) return runnable;
    const plain = runnable.filter((t) => !isMission(t));
    const running = new Map<string, number>();
    for (const a of this.active.values()) {
      if (a.kind !== 'work') continue;
      const m = this.board.exists(a.taskId) ? this.board.read(a.taskId).task.mission : null;
      if (m) running.set(m, (running.get(m) ?? 0) + 1);
    }
    const gate = this.missions.gate(running);
    let free = gate.slots - [...running.values()].reduce((s, n) => s + n, 0);
    let probes = 1;
    const ordered = mission
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (gate.load.get(a.t.mission!) ?? 0) - (gate.load.get(b.t.mission!) ?? 0) || a.i - b.i)
      .map(({ t }) => t);
    const allowed: Task[] = [];
    for (const t of ordered) {
      if (free <= 0) break;
      if (gate.held.has(t.mission!)) {
        // A stale usage figure lets one run through to fetch a fresh one.
        if (!gate.probe.has(t.mission!) || probes <= 0) continue;
        probes--;
      }
      allowed.push(t);
      free--;
    }
    return [...plain, ...allowed];
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
      // Worktree tasks don't hold the workspace; others have it to themselves.
      workspace: kind === 'work' && this.exclusiveWorkspace(task) ? task.workspace : null,
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
    if (task.workspace) fs.mkdirSync(path.join(this.paths.workspaces, task.workspace), { recursive: true });
    const workspaceDir = this.workDir(task, kind);

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
    const model = agent.model ?? this.config.default_model;
    if (model) def.model = model;
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
      fullAccess: this.config.full_access,
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
    if (task.worktree && !task.worktree.removed && workspaceDir === task.worktree.path) {
      lines.push(
        `- 이 작업 공간은 이 업무 전용 git worktree 입니다 (브랜치 ${task.worktree.branch}, 기준 ${task.worktree.base}). 다른 업무가 같은 저장소를 동시에 고치고 있으니 이 폴더에서만 작업하고, 원래 작업 공간 폴더(${path.join(this.paths.workspaces, task.workspace ?? '')})는 고치지 마세요. 브랜치를 바꾸거나(checkout) 기준 브랜치에 직접 커밋하지 마세요.`,
        `- 커밋은 해도 되고 안 해도 됩니다. \`bf task done\` 을 하면 남은 변경을 커밋하고, ${task.worktree.base} 를 합친 뒤 ${task.worktree.base} 에 반영합니다. 충돌이 나면 완료 보고가 거부되고 충돌 파일이 표시되니, 이 폴더에서 해결하고 git add, git commit 한 뒤 다시 완료 보고하세요.`,
        `- node_modules, .env, 빌드 결과물 같은 git 제외 파일은 원래 작업 공간과 링크로 공유됩니다.`,
      );
    }
    const threadSource = originThreadTask(task.origin);
    if (threadSource) {
      lines.push(
        `- 이 업무는 사용자가 업무 ${threadSource} 의 코멘트에서 부탁한 일입니다. 맥락은 \`bf task show ${threadSource}\` 로, 그 업무의 결과물은 ${this.board.taskDir(threadSource)}/output/ 에서 보세요. 끝나면 완료 보고 요약이 그 코멘트에 자동으로 올라가니, 요약은 사용자에게 답하듯 쓰세요.`,
      );
    } else if (task.origin) {
      lines.push(
        `- 이 업무는 사용자가 메신저에서 부탁한 일입니다. 맥락이 필요하면 \`bf chat read ${task.origin.conv}\` 로 대화를 읽으세요. 끝나면 완료 보고 요약이 그 대화에 자동으로 올라가니, 요약은 사용자에게 답하듯 쓰세요.`,
      );
    }
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
    const ended = kids.filter((k) => isTerminal(k.status));
    if (ended.length > 0 && ended.length < kids.length) {
      lines.push(
        `- 끝난 하위 업무 ${ended.map((k) => k.id).join(', ')} 의 결과물과 이력을 확인하세요. 완료 보고에 '못함'·실패가 있으면 그대로 두지 말고, 해결 업무를 만들거나 사용자에게 알리고(사용자 업무 또는 질문), 그 결과를 전제로 한 업무는 고치거나 취소하세요. 문제가 없으면 보고 없이 끝내면 됩니다.`,
      );
    }
    if (kids.length > 0 && kids.every((k) => isTerminal(k.status))) {
      lines.push(
        `- 맡긴 하위 업무가 모두 끝났습니다. 각 하위 업무의 결과물(${this.paths.board}${path.sep}<번호>${path.sep}output)과 이력을 확인해 취합하세요.`,
      );
    }
    const notes = this.board.openThread(task.id, null).filter((e) => e.from === this.config.owner);
    if (notes.length > 0) {
      lines.push(
        `- 사용자가 이 업무에 남긴 코멘트입니다. 반드시 반영하세요 (오래된 것 → 최신):`,
        ...notes.map((e) => `  - ${e.at.slice(0, 16).replace('T', ' ')} ${truncate(e.text.replace(/\s+/g, ' '), 600)}`),
      );
    }
    lines.push(`- 실행 중에도 사용자가 코멘트를 남길 수 있습니다. 완료 보고 직전에 \`bf task show ${task.id}\` 이력에서 새 [${this.config.owner}] 코멘트가 있는지 확인하고 반영하세요.`);
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
      ...this.missionReviewLines(task),
      `- \`bf task show ${task.id}\` 로 완료 조건과 완료 보고를 확인하고, output/ 의 결과물을 직접 열어 확인하세요.`,
      `- 완료 조건을 모두 충족하면 \`bf task pass ${task.id} --note "<확인한 내용>"\``,
      `- 하나라도 미달이면 \`bf task reject ${task.id} "<무엇이 왜 부족하고 어떻게 고쳐야 하는지>"\``,
      `- 이력에 사용자([${this.config.owner}])의 코멘트가 있으면 그 요청도 완료 조건처럼 반영됐는지 보세요.`,
      `- 결과물을 직접 고치지 마세요. 판정만 합니다.`,
    ].join('\n');
  }

  /** A mission step is judged against its charter too; a proposal to end the mission takes effect only if it passes. */
  private missionReviewLines(task: Task): string[] {
    if (!task.mission || task.parent !== null || !missionExists(this.paths, task.mission)) return [];
    const doc = readMission(this.paths, task.mission);
    const lines = [
      `[미션 단계] 이 업무는 미션 ${task.mission} "${doc.mission.title}" 의 단계입니다. 헌장: ${missionFile(this.paths, task.mission)}, 진행 기록: ${journalFile(this.paths, task.mission)}`,
      `- 완료 조건과 함께, 이 단계가 헌장의 성공 판정 기준에 기여했는지 보세요. 하위 업무 3개 이상·외부 공개·결재·방향 전환이 있었는데 계획 검토(--plan-review 하위 업무)가 없었다면 반려하세요.`,
    ];
    const p = task.mission_proposal;
    if (p?.kind === 'achieve') {
      lines.push(`- 이 단계는 미션 달성을 제안했습니다: "${p.text}". 헌장의 성공 판정 기준을 하나씩 대조해 모두 충족했을 때만 통과시키세요. 통과하면 미션이 달성으로 끝납니다.`);
      lines.push(`- 헌장 요약: ${charterOf(doc.body).slice(0, 1500)}`);
    } else if (p?.kind === 'stall') {
      lines.push(`- 이 단계는 진전 없음을 선언했습니다: "${p.text}". 통과하면 미션이 일시정지되고 사용자에게 보고됩니다. 근거가 약하면 반려하세요.`);
    }
    return lines;
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
