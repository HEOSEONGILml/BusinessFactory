import fs from 'node:fs';
import path from 'node:path';
import { listAgents } from './agents.ts';
import type { Config } from './config.ts';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.ts';
import { withLock, writeFileAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

export const STATUSES = [
  'awaiting_approval',
  'pending',
  'running',
  'waiting',
  'blocked',
  'review',
  'done',
  'failed',
  'canceled',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  awaiting_approval: '결재대기',
  pending: '대기',
  running: '진행',
  waiting: '하위대기',
  blocked: '질문대기',
  review: '검수대기',
  done: '완료',
  failed: '실패',
  canceled: '취소',
};

const TERMINAL: ReadonlySet<Status> = new Set(['done', 'failed', 'canceled']);

const TRANSITIONS: Record<Status, readonly Status[]> = {
  awaiting_approval: ['pending', 'canceled'],
  pending: ['running', 'awaiting_approval', 'canceled'],
  running: ['review', 'done', 'blocked', 'waiting', 'pending', 'failed', 'canceled'],
  waiting: ['pending', 'canceled'],
  blocked: ['pending', 'canceled'],
  review: ['done', 'pending', 'failed', 'canceled'],
  done: [],
  failed: [],
  canceled: [],
};

export function isTerminal(status: Status): boolean {
  return TERMINAL.has(status);
}

export interface Task {
  id: string;
  title: string;
  status: Status;
  assignee: string;
  created_by: string;
  parent: string | null;
  depends_on: string[];
  depth: number;
  review: boolean;
  workspace: string | null;
  project: string | null;
  priority: number;
  attempts: number;
  max_attempts: number;
  rejections: number;
  max_rejections: number;
  ask_to: string | null;
  /** Extra permission rules the owner approved for this task only. */
  grants?: string[];
  /** Set while the task is blocked on an owner decision. */
  approval?: Approval | null;
  /** Owner has seen the final result (top-level goals). */
  acknowledged?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  kind: 'action' | 'hire';
  what: string;
  /** Permission rules requested (kind = action). */
  grants: string[];
  /** Proposed employee names waiting in company/hiring (kind = hire). */
  hires: string[];
}

/** Bare file-tool names would grant access to the whole disk; file access is path-scoped by the engine. */
const DISK_WIDE_RULES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'Bash']);

export function checkGrantRule(rule: string): void {
  if (DISK_WIDE_RULES.has(rule.trim())) {
    throw new BoardError(`'${rule}' 는 범위 제한이 없는 권한이라 요청할 수 없습니다. 예: "Bash(npm run deploy:*)"`);
  }
}

export interface TaskDoc {
  task: Task;
  body: string;
}

export interface CreateTaskInput {
  title: string;
  assignee: string;
  doneWhen: string[];
  description?: string;
  dependsOn?: string[];
  review?: boolean;
  workspace?: string | null;
  project?: string | null;
  priority?: number;
  /** Parent task id; null creates a top-level goal (owner only). */
  parent: string | null;
}

/** A rule violation; the message is shown to whoever called bf. */
export class BoardError extends Error {}

export const DEFAULT_GOAL_DONE_WHEN = [
  '목표가 달성되었고, 무엇을 했는지와 결과물 위치를 정리한 보고서가 output/report.md 에 있다',
];

/** Accepts "12", "t12" or "T0012". */
export function normalizeId(raw: string): string {
  const m = /^t?(\d+)$/i.exec(raw.trim());
  if (!m) throw new BoardError(`잘못된 업무 번호: ${raw}`);
  return `T${m[1].padStart(4, '0')}`;
}

export class Board {
  readonly paths: Paths;
  readonly config: Config;
  private readonly now: () => Date;
  private lockDepth = 0;

  constructor(paths: Paths, config: Config, now: () => Date = () => new Date()) {
    this.paths = paths;
    this.config = config;
    this.now = now;
  }

  // ---- reads (no lock needed: every write is an atomic rename) ----

  taskDir(id: string): string {
    return path.join(this.paths.board, id);
  }

  exists(id: string): boolean {
    return fs.existsSync(path.join(this.taskDir(id), 'task.md'));
  }

  read(id: string): TaskDoc {
    const file = path.join(this.taskDir(id), 'task.md');
    if (!fs.existsSync(file)) throw new BoardError(`업무가 없습니다: ${id}`);
    const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    return { task: data as unknown as Task, body };
  }

  readLog(id: string): string {
    const file = path.join(this.taskDir(id), 'log.md');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }

  list(): Task[] {
    if (!fs.existsSync(this.paths.board)) return [];
    return fs
      .readdirSync(this.paths.board)
      .filter((name) => /^T\d+$/.test(name))
      .sort()
      .map((id) => this.read(id).task);
  }

  children(id: string): Task[] {
    return this.list().filter((t) => t.parent === id);
  }

  /** Task priority plus its project's priority. */
  effectivePriority(t: Task): number {
    return t.priority + (t.project ? (this.config.project_priority?.[t.project] ?? 0) : 0);
  }

  /** Pending tasks whose dependencies are all done, highest priority first, then oldest. */
  runnable(): Task[] {
    const all = this.list();
    const byId = new Map(all.map((t) => [t.id, t]));
    return all
      .filter((t) => t.status === 'pending')
      .filter((t) => t.depends_on.every((d) => byId.get(d)?.status === 'done'))
      .sort((a, b) => this.effectivePriority(b) - this.effectivePriority(a) || a.id.localeCompare(b.id));
  }

  // ---- writes ----

  createTask(actor: string, input: CreateTaskInput): Task {
    return this.locked(() => {
      const title = input.title.trim();
      if (!title) throw new BoardError('업무 제목이 비어 있습니다.');
      const doneWhen = input.doneWhen.map((s) => s.trim()).filter(Boolean);
      if (doneWhen.length === 0) {
        throw new BoardError('완료 조건(--done-when)이 없는 업무는 만들 수 없습니다.');
      }
      if (!listAgents(this.paths).some((a) => a.name === input.assignee)) {
        throw new BoardError(`존재하지 않는 직원입니다: ${input.assignee}`);
      }

      let parent: Task | null = null;
      if (input.parent === null) {
        if (actor !== this.config.owner) {
          throw new BoardError('직원은 자신이 수행 중인 업무의 하위 업무만 만들 수 있습니다.');
        }
      } else {
        parent = this.read(input.parent).task;
        if (actor !== this.config.owner && actor !== parent.assignee) {
          throw new BoardError(`${parent.id} 의 담당자가 아니므로 하위 업무를 만들 수 없습니다.`);
        }
        if (isTerminal(parent.status)) {
          throw new BoardError(`${parent.id} 는 이미 종료된 업무입니다.`);
        }
        if (parent.depth + 1 > this.config.max_depth) {
          throw new BoardError(
            `위임 깊이 한도(${this.config.max_depth})를 넘습니다. 직접 수행하거나 상위에 보고하세요.`,
          );
        }
      }

      const dependsOn = (input.dependsOn ?? []).map(normalizeId);
      for (const dep of dependsOn) {
        if (!this.exists(dep)) throw new BoardError(`선행 업무가 없습니다: ${dep}`);
      }

      const id = this.allocateId();
      const ts = this.timestamp();
      const task: Task = {
        id,
        title,
        status: 'pending',
        assignee: input.assignee,
        created_by: actor,
        parent: parent?.id ?? null,
        depends_on: dependsOn,
        depth: parent ? parent.depth + 1 : 0,
        // Whatever reaches the owner is always reviewed.
        review: parent === null ? true : (input.review ?? true),
        workspace: input.workspace ?? parent?.workspace ?? null,
        project: input.project ?? parent?.project ?? null,
        priority: input.priority ?? parent?.priority ?? 0,
        attempts: 0,
        max_attempts: this.config.max_attempts,
        rejections: 0,
        max_rejections: this.config.max_rejections,
        ask_to: null,
        grants: [],
        approval: null,
        acknowledged: false,
        created_at: ts,
        updated_at: ts,
      };
      const body = [
        '## 설명',
        '',
        input.description?.trim() || '(없음)',
        '',
        '## 완료 조건',
        '',
        ...doneWhen.map((d) => `- ${d}`),
        '',
      ].join('\n');

      fs.mkdirSync(path.join(this.taskDir(id), 'output'), { recursive: true });
      this.save({ task, body });
      this.log(id, actor, '생성', `담당: ${task.assignee}${parent ? `, 상위: ${parent.id}` : ''}`);
      return task;
    });
  }

  /** Engine: pending → running. */
  start(id: string, actor = 'engine'): Task {
    return this.locked(() => {
      const doc = this.read(id);
      doc.task.attempts += 1;
      this.transition(doc, 'running');
      this.save(doc);
      this.log(id, actor, '시작', `시도 ${doc.task.attempts}/${doc.task.max_attempts}`);
      return doc.task;
    });
  }

  /** Assignee reports the work finished. */
  done(actor: string, id: string, summary: string): Task {
    return this.locked(() => {
      const doc = this.read(id);
      this.requireAssignee(actor, doc.task);
      this.requireStatus(doc.task, 'running');
      if (!summary.trim()) throw new BoardError('완료 요약(--summary)이 필요합니다.');
      const open = this.children(id).filter((c) => !isTerminal(c.status));
      if (open.length > 0) {
        throw new BoardError(
          `진행 중인 하위 업무가 있어 완료할 수 없습니다: ${open.map((c) => c.id).join(', ')}. ` +
            '하위 업무가 끝나면 다시 깨워집니다.',
        );
      }
      this.transition(doc, doc.task.review ? 'review' : 'done');
      this.save(doc);
      this.log(id, actor, '완료보고', summary);
      if (doc.task.status === 'done') this.settleParent(doc.task);
      return doc.task;
    });
  }

  /** Assignee is stuck and needs an answer from whoever assigned the task. */
  ask(actor: string, id: string, question: string): Task {
    return this.locked(() => {
      const doc = this.read(id);
      this.requireAssignee(actor, doc.task);
      this.requireStatus(doc.task, 'running');
      if (!question.trim()) throw new BoardError('질문 내용이 비어 있습니다.');
      doc.task.ask_to = doc.task.created_by;
      this.transition(doc, 'blocked');
      this.save(doc);
      this.log(id, actor, '질문', `→ ${doc.task.ask_to}: ${question}`);
      // The asker's manager is usually waiting on this very task; wake it up to answer.
      if (doc.task.parent && doc.task.ask_to !== this.config.owner) {
        const parent = this.read(doc.task.parent);
        if (parent.task.status === 'waiting' && parent.task.assignee === doc.task.ask_to) {
          parent.task.attempts = 0;
          this.transition(parent, 'pending');
          this.save(parent);
          this.log(parent.task.id, 'system', '재개', `하위 업무 ${id} 에 질문이 있음`);
        }
      }
      return doc.task;
    });
  }

  answer(actor: string, id: string, text: string): Task {
    return this.locked(() => {
      const doc = this.read(id);
      this.requireStatus(doc.task, 'blocked');
      if (doc.task.approval) {
        throw new BoardError(`${id} 는 결재 대기입니다. bf approve 또는 bf deny 를 쓰세요.`);
      }
      if (actor !== this.config.owner && actor !== doc.task.ask_to) {
        throw new BoardError(`이 질문은 ${doc.task.ask_to} 에게 온 것입니다.`);
      }
      if (!text.trim()) throw new BoardError('답변 내용이 비어 있습니다.');
      doc.task.ask_to = null;
      doc.task.attempts = 0; // progress: count failed runs afresh
      this.transition(doc, 'pending');
      this.save(doc);
      this.log(id, actor, '답변', text);
      return doc.task;
    });
  }

  /**
   * Assignee asks the owner to approve something it may not do on its own.
   * `grants` are permission rules added to this task's runs once approved.
   */
  requestApproval(actor: string, id: string, what: string, grants: string[]): Task {
    return this.locked(() => {
      const doc = this.read(id);
      this.requireAssignee(actor, doc.task);
      this.requireStatus(doc.task, 'running');
      if (!what.trim()) throw new BoardError('결재 내용이 비어 있습니다.');
      grants.forEach(checkGrantRule);
      return this.blockOnOwner(doc, actor, { kind: 'action', what, grants, hires: [] });
    });
  }

  /** HR puts proposed employee definitions (already validated and copied to hiring/) up for approval. */
  requestHire(actor: string, id: string, names: string[]): Task {
    return this.locked(() => {
      const doc = this.read(id);
      this.requireAssignee(actor, doc.task);
      this.requireStatus(doc.task, 'running');
      return this.blockOnOwner(doc, actor, { kind: 'hire', what: `채용: ${names.join(', ')}`, grants: [], hires: names });
    });
  }

  /** Owner approves; `install` puts approved hires on the staff roster. */
  approve(actor: string, id: string, note: string, install: (names: string[]) => void): Task {
    return this.locked(() => {
      const doc = this.read(id);
      const approval = this.requirePendingApproval(actor, doc.task);
      if (approval.kind === 'hire') install(approval.hires);
      if (approval.grants.length) {
        doc.task.grants = [...new Set([...(doc.task.grants ?? []), ...approval.grants])];
      }
      doc.task.approval = null;
      doc.task.ask_to = null;
      this.transition(doc, 'pending');
      this.save(doc);
      this.log(id, actor, '결재승인', [approval.what, note].filter(Boolean).join(' — '));
      return doc.task;
    });
  }

  deny(actor: string, id: string, reason: string, discard: (names: string[]) => void): Task {
    return this.locked(() => {
      const doc = this.read(id);
      const approval = this.requirePendingApproval(actor, doc.task);
      if (!reason.trim()) throw new BoardError('반려 사유가 필요합니다.');
      if (approval.kind === 'hire') discard(approval.hires);
      doc.task.approval = null;
      doc.task.ask_to = null;
      this.transition(doc, 'pending');
      this.save(doc);
      this.log(id, actor, '결재반려', `${approval.what} — ${reason}`);
      return doc.task;
    });
  }

  /** Owner marks a finished goal as seen so it leaves the inbox. */
  acknowledge(actor: string, id: string): Task {
    return this.locked(() => {
      const doc = this.read(id);
      if (actor !== this.config.owner) throw new BoardError('사용자만 확인 처리할 수 있습니다.');
      if (!isTerminal(doc.task.status)) throw new BoardError(`${id} 는 아직 끝나지 않았습니다.`);
      doc.task.acknowledged = true;
      this.save(doc);
      this.log(id, actor, '확인', '');
      return doc.task;
    });
  }

  pass(actor: string, id: string, note = ''): Task {
    return this.locked(() => {
      const doc = this.read(id);
      this.requireReviewer(actor, doc.task);
      this.requireStatus(doc.task, 'review');
      this.transition(doc, 'done');
      this.save(doc);
      this.log(id, actor, '검수통과', note);
      this.settleParent(doc.task);
      return doc.task;
    });
  }

  reject(actor: string, id: string, reason: string): Task {
    return this.locked(() => {
      const doc = this.read(id);
      this.requireReviewer(actor, doc.task);
      this.requireStatus(doc.task, 'review');
      if (!reason.trim()) throw new BoardError('반려 사유가 필요합니다.');
      doc.task.rejections += 1;
      const exhausted = doc.task.rejections >= doc.task.max_rejections;
      this.transition(doc, exhausted ? 'failed' : 'pending');
      this.save(doc);
      this.log(id, actor, '반려', `(${doc.task.rejections}/${doc.task.max_rejections}) ${reason}`);
      if (exhausted) {
        this.log(id, 'system', '실패', '반려 한도 소진');
        this.settleParent(doc.task);
      }
      return doc.task;
    });
  }

  comment(actor: string, id: string, text: string): void {
    this.locked(() => {
      this.read(id);
      if (!text.trim()) throw new BoardError('코멘트 내용이 비어 있습니다.');
      this.log(id, actor, '코멘트', text);
    });
  }

  /** Cancels the task and every unfinished descendant. */
  cancel(actor: string, id: string, reason = ''): Task {
    return this.locked(() => {
      const doc = this.read(id);
      if (actor !== this.config.owner && actor !== doc.task.created_by) {
        throw new BoardError('지시자 또는 사용자만 업무를 취소할 수 있습니다.');
      }
      if (isTerminal(doc.task.status)) {
        throw new BoardError(`${id} 는 이미 ${STATUS_LABEL[doc.task.status]} 상태입니다.`);
      }
      const all = this.list();
      const cancelTree = (taskId: string) => {
        for (const child of all.filter((t) => t.parent === taskId)) {
          if (!isTerminal(child.status)) {
            const childDoc = this.read(child.id);
            this.transition(childDoc, 'canceled');
            this.save(childDoc);
            this.log(child.id, actor, '취소', `상위 업무 ${id} 취소에 따름`);
          }
          cancelTree(child.id);
        }
      };
      cancelTree(id);
      this.transition(doc, 'canceled');
      this.save(doc);
      this.log(id, actor, '취소', reason);
      this.settleParent(doc.task);
      return doc.task;
    });
  }

  /**
   * Engine: a run ended without the assignee calling done/ask.
   * If it delegated work, wait for it; otherwise count a failed attempt.
   */
  finishRun(id: string, note: string): Task {
    return this.locked(() => {
      const doc = this.read(id);
      if (doc.task.status !== 'running') return doc.task;
      const open = this.children(id).filter((c) => !isTerminal(c.status));
      if (open.length > 0) {
        const unanswered = open.filter((c) => c.status === 'blocked' && !c.approval && c.ask_to === doc.task.assignee);
        if (unanswered.length > 0) {
          if (doc.task.attempts < doc.task.max_attempts) {
            // Waiting would deadlock: the children are waiting on us.
            this.transition(doc, 'pending');
            this.save(doc);
            this.log(id, 'engine', '재시도대기', `하위 업무 ${unanswered.map((c) => c.id).join(', ')} 의 질문에 답하지 않고 종료`);
            return doc.task;
          }
          // Repeatedly couldn't answer: hand the questions to the owner instead.
          for (const c of unanswered) {
            const childDoc = this.read(c.id);
            childDoc.task.ask_to = this.config.owner;
            this.save(childDoc);
            this.log(c.id, 'system', '질문이관', `${doc.task.assignee} 가 답하지 못해 사용자에게 넘김`);
          }
        }
        this.transition(doc, 'waiting');
        this.save(doc);
        this.log(id, 'engine', '하위대기', `하위 업무 ${open.map((c) => c.id).join(', ')} 완료 대기`);
        return doc.task;
      }
      const exhausted = doc.task.attempts >= doc.task.max_attempts;
      this.transition(doc, exhausted ? 'failed' : 'pending');
      this.save(doc);
      this.log(id, 'engine', exhausted ? '실패' : '재시도대기', note);
      if (exhausted) this.settleParent(doc.task);
      return doc.task;
    });
  }

  /** Engine: return a running task to the queue without spending an attempt (e.g. usage limit hit). */
  requeue(id: string, note: string): Task {
    return this.locked(() => {
      const doc = this.read(id);
      if (doc.task.status !== 'running') return doc.task;
      doc.task.attempts = Math.max(0, doc.task.attempts - 1);
      this.transition(doc, 'pending');
      this.save(doc);
      this.log(id, 'engine', '대기복귀', note);
      return doc.task;
    });
  }

  // ---- internals (callers already hold the lock) ----

  private locked<T>(fn: () => T): T {
    if (this.lockDepth > 0) return fn();
    fs.mkdirSync(this.paths.company, { recursive: true });
    return withLock(this.paths.lock, () => {
      this.lockDepth++;
      try {
        return fn();
      } finally {
        this.lockDepth--;
      }
    });
  }

  /** When a task ends, a parent waiting on its children wakes up once they have all ended. */
  private settleParent(task: Task): void {
    if (!task.parent) return;
    const parentDoc = this.read(task.parent);
    if (parentDoc.task.status !== 'waiting') return;
    if (this.children(task.parent).some((c) => !isTerminal(c.status))) return;
    parentDoc.task.attempts = 0; // progress: count failed runs afresh
    this.transition(parentDoc, 'pending');
    this.save(parentDoc);
    this.log(task.parent, 'system', '재개', '하위 업무가 모두 종료되어 결과 취합 차례');
  }

  private blockOnOwner(doc: TaskDoc, actor: string, approval: Approval): Task {
    doc.task.approval = approval;
    doc.task.ask_to = this.config.owner;
    this.transition(doc, 'blocked');
    this.save(doc);
    const extra = approval.grants.length ? ` (요청 권한: ${approval.grants.join(', ')})` : '';
    this.log(doc.task.id, actor, '결재요청', approval.what + extra);
    return doc.task;
  }

  private requirePendingApproval(actor: string, task: Task): Approval {
    if (actor !== this.config.owner) throw new BoardError('결재는 사용자만 할 수 있습니다.');
    if (task.status !== 'blocked' || !task.approval) throw new BoardError(`${task.id} 는 결재 대기 중이 아닙니다.`);
    return task.approval;
  }

  private transition(doc: TaskDoc, to: Status): void {
    const from = doc.task.status;
    if (!TRANSITIONS[from].includes(to)) {
      throw new BoardError(`${doc.task.id}: ${STATUS_LABEL[from]} → ${STATUS_LABEL[to]} 전환은 허용되지 않습니다.`);
    }
    doc.task.status = to;
  }

  private requireStatus(task: Task, status: Status): void {
    if (task.status !== status) {
      throw new BoardError(
        `${task.id} 는 ${STATUS_LABEL[task.status]} 상태입니다 (${STATUS_LABEL[status]} 상태여야 함).`,
      );
    }
  }

  private requireAssignee(actor: string, task: Task): void {
    if (actor !== this.config.owner && actor !== task.assignee) {
      throw new BoardError(`${task.id} 의 담당자는 ${task.assignee} 입니다.`);
    }
  }

  private requireReviewer(actor: string, task: Task): void {
    const allowed = [this.config.owner, this.config.reviewer, task.created_by];
    if (!allowed.includes(actor)) {
      throw new BoardError('검수 판정은 검수자, 지시자, 사용자만 할 수 있습니다.');
    }
    if (actor === task.assignee && actor !== this.config.owner) {
      throw new BoardError('자기 업무는 직접 검수할 수 없습니다.');
    }
  }

  private allocateId(): string {
    fs.mkdirSync(this.paths.board, { recursive: true });
    let next = 1;
    if (fs.existsSync(this.paths.nextId)) {
      next = Number.parseInt(fs.readFileSync(this.paths.nextId, 'utf8'), 10) || 1;
    }
    // Never reuse an id even if the counter file was lost.
    while (this.exists(`T${String(next).padStart(4, '0')}`)) next++;
    writeFileAtomic(this.paths.nextId, String(next + 1));
    return `T${String(next).padStart(4, '0')}`;
  }

  private save(doc: TaskDoc): void {
    doc.task.updated_at = this.timestamp();
    writeFileAtomic(path.join(this.taskDir(doc.task.id), 'task.md'), stringifyFrontmatter(doc.task, doc.body));
  }

  private log(id: string, actor: string, event: string, message: string): void {
    const lines = message.trim().split('\n');
    const head = `- ${this.timestamp()} [${actor}] ${event}${lines[0] ? `: ${lines[0]}` : ''}`;
    const rest = lines.slice(1).map((l) => `  ${l}`);
    fs.appendFileSync(path.join(this.taskDir(id), 'log.md'), [head, ...rest].join('\n') + '\n', 'utf8');
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
