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
import { dueSchedules } from './schedule.ts';
import type { Access, RunResult, RunSpec } from './runner.ts';

export type RunKind = 'work' | 'review';

export interface EngineOptions {
  /** Replaces the real Claude Code launcher (tests). */
  run?: (spec: RunSpec) => Promise<RunResult>;
  now?: () => Date;
  log?: (line: string) => void;
}

interface ActiveRun {
  taskId: string;
  kind: RunKind;
  agent: string;
  workspace: string | null;
  promise: Promise<void>;
}

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
  private systemSnapshot: string | null = null;

  constructor(paths: Paths, config: Config, opts: EngineOptions = {}) {
    this.paths = paths;
    this.config = config;
    this.now = opts.now ?? (() => new Date());
    this.board = new Board(paths, config, this.now);
    this.run = opts.run ?? ((spec) => runAgent(spec));
    this.log = opts.log ?? ((line) => console.log(`[${this.now().toLocaleTimeString()}] ${line}`));
  }

  get halted(): string | null {
    return this.haltReason;
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
    if (this.haltReason) return;
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
  }

  /** Resolves when every launched run has been processed. */
  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.race([...this.active.values()].map((a) => a.promise));
    }
  }

  /** Runs until nothing is runnable, nothing is active, and no pause is pending. */
  async runUntilIdle(): Promise<void> {
    this.recover();
    for (;;) {
      this.tick();
      if (this.active.size === 0) return;
      await Promise.race([...this.active.values()].map((a) => a.promise));
    }
  }

  /** The long-running loop behind `bf engine`. */
  async loop(signal: AbortSignal): Promise<void> {
    this.recover();
    this.log(`엔진 시작 (동시 실행 ${this.config.max_concurrency}, 직원 ${listAgents(this.paths).length}명)`);
    while (!signal.aborted && !this.haltReason) {
      this.tick();
      await sleep(this.config.poll_seconds * 1000, signal);
    }
    if (this.active.size > 0) this.log(`진행 중인 실행 ${this.active.size}건이 끝나기를 기다립니다...`);
    await this.drain();
    if (this.haltReason) this.log(`엔진 정지: ${this.haltReason}`);
  }

  // ---- scheduling ----

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
    const entry: ActiveRun = { taskId: task.id, kind, agent: agent.name, workspace: task.workspace, promise: Promise.resolve() };
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
    this.commit(`${taskId} ${agent.name}: ${STATUS_LABEL[this.board.read(taskId).task.status]}`);
  }

  private recordUsage(taskId: string, kind: RunKind, agent: string, r: RunResult): void {
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
    this.log(`!!! ${reason}`);
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
