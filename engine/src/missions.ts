import fs from 'node:fs';
import path from 'node:path';
import { Board, BoardError, isTerminal, lastLogEntry, STATUS_LABEL } from './board.ts';
import type { Task } from './board.ts';
import { dmId, ensureDm, ensureMissionChannel, postMessage, projectOf, withDecisions } from './chat.ts';
import type { Config } from './config.ts';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.ts';
import { withLock, writeFileAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';
import { cronMatcher } from './schedule.ts';
import type { Notice } from './notify.ts';
import { readUsageSnapshot } from './watch.ts';

/**
 * Missions: a quarter-sized direction the company pursues on its own, one step (a top-level goal
 * for the ceo) at a time. The engine only keeps the loop going, records it and enforces the limits;
 * what each step does is decided by the employee running it. See docs/MISSIONS.md.
 *
 * company/missions/M001/mission.md  YAML meta + charter (the owner's original words are kept)
 * company/missions/M001/journal.md  append-only record of steps and events
 */

export type MissionStatus = 'active' | 'paused' | 'achieved' | 'stopped';

export const MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  active: '진행',
  paused: '일시정지',
  achieved: '달성',
  stopped: '중지',
};

export type MissionHold = 'budget' | 'ceiling';

export interface Mission {
  id: string;
  title: string;
  status: MissionStatus;
  /** Share of the mission budget, relative to the other active missions. */
  weight: number;
  /** Deadline (YYYY-MM-DD = end of that day, local time, or an ISO time). */
  until: string | null;
  project: string | null;
  workspace: string | null;
  /** Why it is paused or stopped. */
  paused_reason: string | null;
  /** Engine: why its work is waiting right now (usage), so the owner hears about changes once. */
  hold: MissionHold | null;
  /** Streaks (failed/empty steps) only count steps created after this. */
  resumed_at: string | null;
  /** Engine: one-time alerts already sent for the current step. */
  alerts: string[];
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface MissionDoc {
  mission: Mission;
  body: string;
}

export const STEP_DONE_WHEN = [
  'output/plan.md 에 헌장 대비 평가와 이번 단계의 계획이 있다 (큰 단계면 계획 검토 반영 내용 포함)',
  "output/report.md 에 한 일, 결과물 위치, 헌장 대비 진척이 있고, 완료 보고 요약 마지막 줄이 '다음:' 으로 시작한다",
];

/** Files a step may leave in output/ without counting as having produced something. */
const STEP_PAPERWORK = new Set(['plan.md', 'report.md', 'plan-review.md']);

export function missionsDir(paths: Paths): string {
  return path.join(paths.company, 'missions');
}

function missionDir(paths: Paths, id: string): string {
  return path.join(missionsDir(paths), id);
}

export function missionFile(paths: Paths, id: string): string {
  return path.join(missionDir(paths, id), 'mission.md');
}

export function journalFile(paths: Paths, id: string): string {
  return path.join(missionDir(paths, id), 'journal.md');
}

/** Accepts "1", "m1" or "M001". */
export function normalizeMissionId(raw: string | undefined): string {
  const m = /^m?(\d+)$/i.exec((raw ?? '').trim());
  if (!m) throw new BoardError(`잘못된 미션 번호: ${raw ?? '(없음)'}`);
  return `M${m[1].padStart(3, '0')}`;
}

function lockDir(paths: Paths): string {
  return path.join(paths.company, '.mission-lock');
}

function withMissionLock<T>(paths: Paths, fn: () => T): T {
  fs.mkdirSync(paths.company, { recursive: true });
  return withLock(lockDir(paths), fn);
}

export function missionExists(paths: Paths, id: string): boolean {
  return fs.existsSync(missionFile(paths, id));
}

export function readMission(paths: Paths, id: string): MissionDoc {
  const file = missionFile(paths, id);
  if (!fs.existsSync(file)) throw new BoardError(`미션이 없습니다: ${id}`);
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const d = data as Partial<Mission>;
  // Fill what older or hand-written files may lack.
  const mission: Mission = {
    id,
    title: String(d.title ?? id),
    status: (d.status as MissionStatus) ?? 'active',
    weight: typeof d.weight === 'number' && d.weight > 0 ? d.weight : 1,
    until: d.until ? String(d.until) : null,
    project: d.project ?? null,
    workspace: d.workspace ?? null,
    paused_reason: d.paused_reason ?? null,
    hold: d.hold ?? null,
    resumed_at: d.resumed_at ?? null,
    alerts: Array.isArray(d.alerts) ? d.alerts.map(String) : [],
    created_at: String(d.created_at ?? ''),
    updated_at: String(d.updated_at ?? ''),
    ended_at: d.ended_at ?? null,
  };
  return { mission, body };
}

export function listMissions(paths: Paths): Mission[] {
  const dir = missionsDir(paths);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^M\d+$/.test(n) && fs.existsSync(missionFile(paths, n)))
    .sort()
    .map((n) => readMission(paths, n).mission);
}

function saveMission(paths: Paths, doc: MissionDoc, now: Date): void {
  doc.mission.updated_at = now.toISOString();
  writeFileAtomic(missionFile(paths, doc.mission.id), stringifyFrontmatter(doc.mission, doc.body));
}

/** Read-modify-write under the mission lock (the CLI and the engine both write). */
export function updateMission(paths: Paths, id: string, now: Date, fn: (doc: MissionDoc) => void): Mission {
  return withMissionLock(paths, () => {
    const doc = readMission(paths, id);
    fn(doc);
    saveMission(paths, doc, now);
    return doc.mission;
  });
}

export function readJournal(paths: Paths, id: string): string {
  const file = journalFile(paths, id);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/**
 * One line per project the step's subtasks worked in, pointing at its channel, so the mission
 * channel shows where the details are without repeating them.
 */
export function projectPointers(tasks: Task[]): string[] {
  const by = new Map<string, Task[]>();
  for (const t of tasks) {
    const p = projectOf(t);
    if (p) by.set(p, [...(by.get(p) ?? []), t]);
  }
  return [...by].map(([p, ts]) => {
    const done = ts.filter((t) => t.status === 'done');
    const failed = ts.filter((t) => t.status === 'failed').length;
    const titles = done.slice(0, 3).map((t) => `${t.id} ${t.title.length > 40 ? t.title.slice(0, 40) + '…' : t.title}`);
    return `- 프로젝트 #${p.toLowerCase()}: 업무 ${ts.length}건 (완료 ${done.length}${failed ? `, 실패 ${failed}` : ''})${titles.length ? ` — ${titles.join(', ')}${done.length > 3 ? ' 외' : ''}` : ''} · 상세는 #${p.toLowerCase()}`;
  });
}

export function appendJournal(paths: Paths, id: string, now: Date, heading: string, lines: string[] = []): void {
  const text = [`## ${heading} · ${now.toISOString()}`, '', ...lines, ''].join('\n') + '\n';
  fs.appendFileSync(journalFile(paths, id), text, 'utf8');
  shareInChannel(paths, id, heading, lines);
}

/** Every journal entry is also shared, briefly, in the mission's channel (#m001). Best-effort. */
function shareInChannel(paths: Paths, id: string, heading: string, lines: string[]): void {
  try {
    const m = missionExists(paths, id) ? readMission(paths, id).mission : null;
    const conv = ensureMissionChannel(paths, id, m?.title ?? null, m?.project ?? null);
    const body = withDecisions(lines.join('\n').trim(), 3000);
    postMessage(paths, conv.id, 'ceo', `🎯 **${id} ${heading}**${body ? `\n\n${body}` : ''}`, { chain: 99, kind: 'system' });
  } catch {
    // sharing is best-effort; the journal keeps the record
  }
}

export interface CreateMissionInput {
  title: string;
  brief: string;
  weight?: number;
  until?: string | null;
  project?: string | null;
  workspace?: string | null;
}

export function createMission(paths: Paths, actor: string, input: CreateMissionInput, now: Date): Mission {
  const title = input.title.trim();
  if (!title) throw new BoardError('미션 제목이 비어 있습니다.');
  if (input.until) parseUntil(input.until);
  if (input.weight !== undefined && !(input.weight > 0)) throw new BoardError('가중치(--weight)는 0보다 커야 합니다.');
  return withMissionLock(paths, () => {
    const dir = missionsDir(paths);
    fs.mkdirSync(dir, { recursive: true });
    const used = fs.readdirSync(dir).map((n) => /^M(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number);
    const id = `M${String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0')}`;
    const ts = now.toISOString();
    const mission: Mission = {
      id,
      title,
      status: 'active',
      weight: input.weight ?? 1,
      until: input.until ?? null,
      project: input.project ?? null,
      workspace: input.workspace ?? null,
      paused_reason: null,
      hold: null,
      resumed_at: null,
      alerts: [],
      created_at: ts,
      updated_at: ts,
      ended_at: null,
    };
    const brief = input.brief.trim() || title;
    const body = ['## 원문', '', brief, '', '## 헌장', '', brief, ''].join('\n');
    fs.mkdirSync(missionDir(paths, id), { recursive: true });
    saveMission(paths, { mission, body }, now);
    appendJournal(paths, id, now, '등록', [`- ${actor}: ${title}`, ...(mission.until ? [`- 기한: ${mission.until}`] : [])]);
    return mission;
  });
}

/** The charter section (the owner's original words stay under '원문'). */
export function charterOf(body: string): string {
  const m = /## 헌장\n([\s\S]*)$/.exec(body);
  return (m ? m[1] : body).trim();
}

export function setCharter(paths: Paths, id: string, actor: string, text: string, now: Date): Mission {
  if (!text.trim()) throw new BoardError('헌장 내용이 비어 있습니다.');
  const m = updateMission(paths, id, now, (doc) => {
    const original = /## 원문\n([\s\S]*?)(?=\n## 헌장\n|$)/.exec(doc.body)?.[1]?.trim() ?? charterOf(doc.body);
    doc.body = ['## 원문', '', original, '', '## 헌장', '', text.trim(), ''].join('\n');
  });
  appendJournal(paths, id, now, `헌장 보강 (${actor})`, [text.trim().split('\n').slice(0, 30).join('\n')]);
  return m;
}

export function parseUntil(until: string): Date {
  const s = until.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new BoardError(`잘못된 기한: ${until} (예: 2026-12-31)`);
  return d;
}

export function deadlinePassed(m: Mission, now: Date): boolean {
  return !!m.until && now > parseUntil(m.until);
}

// ---- steps and usage, all derived from the board ----

/** The mission's steps (its top-level goals), oldest first. */
export function missionSteps(tasks: Task[], id: string): Task[] {
  return tasks.filter((t) => t.mission === id && t.parent === null).sort((a, b) => a.id.localeCompare(b.id));
}

export function descendantsOf(tasks: Task[], id: string): Task[] {
  const kids = new Map<string, Task[]>();
  for (const t of tasks) if (t.parent) kids.set(t.parent, [...(kids.get(t.parent) ?? []), t]);
  const out: Task[] = [];
  const walk = (pid: string) => {
    for (const k of kids.get(pid) ?? []) {
      out.push(k);
      walk(k.id);
    }
  };
  walk(id);
  return out;
}

interface UsageRow {
  at: number;
  task: string;
  cost: number;
}

let usageCache: { key: string; rows: UsageRow[] } | null = null;

/** usage.jsonl, parsed once per change (the engine asks every few seconds). Chat rows carry conversation ids and match no task. */
function usageRows(paths: Paths): UsageRow[] {
  const file = path.join(paths.company, 'usage.jsonl');
  if (!fs.existsSync(file)) return [];
  const st = fs.statSync(file);
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (usageCache?.key === key) return usageCache.rows;
  const rows: UsageRow[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      rows.push({ at: Date.parse(e.at), task: String(e.task ?? ''), cost: Number(e.cost_usd_estimate) || 0 });
    } catch {
      // a torn line must not stop the company
    }
  }
  usageCache = { key, rows };
  return rows;
}

/** Estimated usage per mission: all runs on its tasks since `since` (work, review and comment runs). */
export function missionUsage(paths: Paths, tasks: Task[], since: number): Map<string, number> {
  const owner = new Map(tasks.filter((t) => t.mission).map((t) => [t.id, t.mission!]));
  const out = new Map<string, number>();
  for (const r of usageRows(paths)) {
    if (r.at < since) continue;
    const m = owner.get(r.task);
    if (m) out.set(m, (out.get(m) ?? 0) + r.cost);
  }
  return out;
}

/** Runs and usage of one task's runs (for the journal). */
function taskRuns(paths: Paths, ids: Set<string>): { runs: number; cost: number } {
  let runs = 0;
  let cost = 0;
  for (const r of usageRows(paths)) {
    if (!ids.has(r.task)) continue;
    runs++;
    cost += r.cost;
  }
  return { runs, cost };
}

/** The mission's share of the weekly budget, or null when there is no budget. */
export function missionShare(config: Config, missions: Mission[], m: Mission): number | null {
  const budget = config.missions.weekly_budget_usd;
  if (budget === null || budget === undefined) return null;
  const active = missions.filter((x) => x.status === 'active' || x.id === m.id);
  const total = active.reduce((s, x) => s + x.weight, 0) || 1;
  return (budget * m.weight) / total;
}

/** The `다음:` line the step left for the next one. */
export function nextJudgement(summary: string): string {
  const line = summary
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(\*\*)?다음(\*\*)?\s*[:：]/.test(l))
    .pop();
  return line ? line.replace(/^(\*\*)?다음(\*\*)?\s*[:：]\s*/, '').trim() : '';
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function hoursSince(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 3_600_000;
}

// ---- owner controls (CLI and web) ----

export function pauseMission(paths: Paths, id: string, actor: string, reason: string, now: Date): Mission {
  const m = updateMission(paths, id, now, (doc) => {
    if (doc.mission.status !== 'active') throw new BoardError(`${id} 는 ${MISSION_STATUS_LABEL[doc.mission.status]} 상태라 일시정지할 수 없습니다.`);
    doc.mission.status = 'paused';
    doc.mission.paused_reason = reason.trim() || `${actor} 가 일시정지`;
  });
  appendJournal(paths, id, now, `일시정지 (${actor})`, [`- ${m.paused_reason}`]);
  return m;
}

export function resumeMission(paths: Paths, id: string, actor: string, now: Date): Mission {
  const m = updateMission(paths, id, now, (doc) => {
    if (doc.mission.status !== 'paused') throw new BoardError(`${id} 는 일시정지 상태가 아닙니다 (${MISSION_STATUS_LABEL[doc.mission.status]}).`);
    doc.mission.status = 'active';
    doc.mission.paused_reason = null;
    doc.mission.resumed_at = now.toISOString();
  });
  appendJournal(paths, id, now, `재개 (${actor})`);
  return m;
}

/** Stop for good. The running step finishes unless `cancelRunning`. */
export function stopMission(board: Board, id: string, actor: string, reason: string, cancelRunning: boolean, now: Date): Mission {
  const paths = board.paths;
  const m = updateMission(paths, id, now, (doc) => {
    if (doc.mission.status === 'achieved' || doc.mission.status === 'stopped') {
      throw new BoardError(`${id} 는 이미 ${MISSION_STATUS_LABEL[doc.mission.status]} 상태입니다.`);
    }
    doc.mission.status = 'stopped';
    doc.mission.paused_reason = reason.trim() || `${actor} 가 중지`;
    doc.mission.ended_at = now.toISOString();
  });
  const open = missionSteps(board.list(), id).filter((t) => !isTerminal(t.status));
  if (cancelRunning) for (const t of open) board.cancel(board.config.owner, t.id, `미션 ${id} 중지`);
  appendJournal(paths, id, now, `중지 (${actor})`, [
    `- ${m.paused_reason}`,
    ...(open.length ? [cancelRunning ? `- 진행 중이던 단계 취소: ${open.map((t) => t.id).join(', ')}` : `- 진행 중인 단계 ${open.map((t) => t.id).join(', ')} 는 끝까지 진행`] : []),
  ]);
  return m;
}

export function setMission(paths: Paths, id: string, actor: string, changes: { weight?: number; until?: string | null; title?: string }, now: Date): Mission {
  if (changes.weight !== undefined && !(changes.weight > 0)) throw new BoardError('가중치(--weight)는 0보다 커야 합니다.');
  if (changes.until) parseUntil(changes.until);
  const notes: string[] = [];
  const m = updateMission(paths, id, now, (doc) => {
    if (changes.weight !== undefined) {
      notes.push(`- 가중치 ${doc.mission.weight} → ${changes.weight}`);
      doc.mission.weight = changes.weight;
    }
    if (changes.until !== undefined) {
      notes.push(`- 기한 ${doc.mission.until ?? '없음'} → ${changes.until || '없음'}`);
      doc.mission.until = changes.until || null;
    }
    if (changes.title?.trim()) {
      notes.push(`- 제목 ${doc.mission.title} → ${changes.title.trim()}`);
      doc.mission.title = changes.title.trim();
    }
  });
  if (notes.length === 0) throw new BoardError('바꿀 항목이 없습니다 (--weight, --until, --title).');
  appendJournal(paths, id, now, `설정 변경 (${actor})`, notes);
  return m;
}

/**
 * `bf mission achieve/stall`: from a running step it is a proposal that takes effect when the step
 * passes review; the owner may also achieve a mission outright.
 */
export function proposeOrDecide(board: Board, id: string, actor: string, currentTask: string | null, kind: 'achieve' | 'stall', text: string, now: Date): string {
  const paths = board.paths;
  const doc = readMission(paths, id);
  if (doc.mission.status === 'achieved' || doc.mission.status === 'stopped') {
    throw new BoardError(`${id} 는 이미 ${MISSION_STATUS_LABEL[doc.mission.status]} 상태입니다.`);
  }
  if (!text.trim()) throw new BoardError(kind === 'achieve' ? '근거(--summary)가 필요합니다.' : '이유(--reason)가 필요합니다.');
  if (actor === board.config.owner && !currentTask) {
    if (kind === 'stall') {
      pauseMission(paths, id, actor, `진전 없음: ${text}`, now);
      return `${id} → 일시정지`;
    }
    updateMission(paths, id, now, (d) => {
      d.mission.status = 'achieved';
      d.mission.ended_at = now.toISOString();
    });
    appendJournal(paths, id, now, `달성 (${actor})`, [text.trim()]);
    return `${id} → 달성`;
  }
  if (!currentTask) throw new BoardError('미션 단계를 수행 중일 때만 쓸 수 있습니다.');
  const step = board.read(currentTask).task;
  if (step.mission !== id || step.parent !== null) throw new BoardError(`${currentTask} 는 미션 ${id} 의 단계가 아닙니다.`);
  board.proposeMission(actor, step.id, kind, text);
  return kind === 'achieve'
    ? `${step.id}: 달성 제안을 기록했습니다. 보고서를 쓰고 완료 보고하세요. 검수를 통과하면 미션이 달성으로 확정됩니다.`
    : `${step.id}: 진전 없음을 기록했습니다. 완료 보고하세요. 검수를 통과하면 미션이 일시정지되고 사용자에게 보고됩니다.`;
}

/** Who may rewrite the charter: the owner, or the employee running one of its steps. */
export function checkCharterActor(board: Board, id: string, actor: string, currentTask: string | null): void {
  if (actor === board.config.owner) return;
  const step = currentTask ? board.read(currentTask).task : null;
  if (!step || step.mission !== id || step.parent !== null || step.assignee !== actor) {
    throw new BoardError('헌장은 사용자 또는 그 미션의 단계를 수행 중인 담당자만 고칠 수 있습니다.');
  }
}

// ---- the engine side ----

export interface MissionLoopDeps {
  board: Board;
  paths: Paths;
  config: Config;
  now: () => Date;
  log: (line: string) => void;
  notify: (n: Notice) => void;
}

/** What the engine needs to order and limit work: per-mission state at this moment. */
export interface MissionGate {
  /** Mission tasks that may not start, keyed by mission id, with the reason. */
  held: Map<string, string>;
  /** 7-day usage ÷ weight, for ordering mission work (less used first). */
  load: Map<string, number>;
  /** Slots mission work may hold at once. */
  slots: number;
  /** A mission whose ceiling hold may let one run through to refresh the usage figure. */
  probe: Set<string>;
}

/**
 * Called by the engine every pass: settles finished steps (journal, achieve/stall, safety limits),
 * creates the next step, sends event and daily reports. Nothing here runs Claude.
 */
export class MissionLoop {
  private readonly d: MissionLoopDeps;

  constructor(deps: MissionLoopDeps) {
    this.d = deps;
  }

  private get paths(): Paths {
    return this.d.paths;
  }

  tick(): void {
    const missions = listMissions(this.paths);
    if (missions.length === 0) return;
    for (const m of missions) {
      try {
        this.tickMission(m.id);
      } catch (e) {
        this.d.log(`미션 ${m.id} 처리 오류: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.dailyReport();
  }

  /** Per-mission limits for this pass (engine.candidates). */
  gate(activeMissionRuns: Map<string, number>): MissionGate {
    const missions = listMissions(this.paths);
    const tasks = this.d.board.list();
    const now = this.d.now();
    const usage = missionUsage(this.paths, tasks, now.getTime() - 7 * 86_400_000);
    const held = new Map<string, string>();
    const load = new Map<string, number>();
    const probe = new Set<string>();
    const ceiling = this.ceilingState(now);
    for (const m of missions) {
      load.set(m.id, (usage.get(m.id) ?? 0) / m.weight);
      if (m.status === 'paused') held.set(m.id, '일시정지');
      else if (this.overBudget(m, missions, usage)) held.set(m.id, '미션 예산 초과');
      else if (ceiling.over) {
        held.set(m.id, ceiling.reason);
        if (ceiling.stale) probe.add(m.id);
      }
    }
    // A stale snapshot lets one mission run go through so it brings back fresh usage figures.
    if (probe.size && [...activeMissionRuns.values()].some((n) => n > 0)) probe.clear();
    const cfg = this.d.config.missions.max_slots;
    const slots = cfg === null || cfg === undefined ? Math.max(1, this.d.config.max_concurrency - 1) : Math.max(0, cfg);
    return { held, load, slots, probe };
  }

  private overBudget(m: Mission, missions: Mission[], usage: Map<string, number>): boolean {
    const share = missionShare(this.d.config, missions, m);
    return share !== null && (usage.get(m.id) ?? 0) >= share;
  }

  /** Subscription seven_day use at or over the mission ceiling. Stale: the figure is old enough to re-check. */
  private ceilingState(now: Date): { over: boolean; stale: boolean; reason: string } {
    const snap = readUsageSnapshot(this.paths);
    const w = snap?.windows?.seven_day;
    const limit = this.d.config.missions.seven_day_ceiling;
    if (!snap || !w || !(w.utilization >= limit)) return { over: false, stale: false, reason: '' };
    if (w.resetsAt && w.resetsAt * 1000 <= now.getTime()) return { over: false, stale: false, reason: '' };
    const stale = hoursSince(snap.at, now) >= this.d.config.missions.probe_after_hours;
    return { over: true, stale, reason: `구독 7일 사용률 ${Math.round(w.utilization * 100)}% (미션 상한 ${Math.round(limit * 100)}%)` };
  }

  private tickMission(id: string): void {
    const now = this.d.now();
    const board = this.d.board;
    let m = readMission(this.paths, id).mission;
    const tasks = board.list();
    const steps = missionSteps(tasks, id);
    const journal = readJournal(this.paths, id);
    for (const step of steps.filter((t) => isTerminal(t.status) && !journal.includes(`· ${t.id} ·`))) {
      this.settleStep(m, step, steps, tasks);
      m = readMission(this.paths, id).mission;
    }
    if (m.status !== 'active') return;

    const open = steps.filter((t) => !isTerminal(t.status));
    for (const step of open) this.watchStep(m, step, tasks, now);
    if (open.length === 0 && deadlinePassed(m, now)) {
      this.endMission(m, 'stopped', `기한(${m.until}) 도래`);
      return;
    }
    // Usage limits hold both the next step and the running step's work (engine gate); report changes once.
    const missions = listMissions(this.paths);
    const usage = missionUsage(this.paths, tasks, now.getTime() - 7 * 86_400_000);
    const ceiling = this.ceilingState(now);
    const hold: MissionHold | null = this.overBudget(m, missions, usage) ? 'budget' : ceiling.over ? 'ceiling' : null;
    if (hold !== m.hold) {
      updateMission(this.paths, id, now, (doc) => (doc.mission.hold = hold));
      const share = missionShare(this.d.config, missions, m);
      const text = hold === 'budget'
        ? `미션 예산을 다 써서 이 미션의 새 업무를 멈춥니다 (7일 ${fmtUsd(usage.get(id) ?? 0)} / 몫 ${fmtUsd(share ?? 0)}). 진행 중인 실행과 검수는 마칩니다. 7일 창이 풀리면 자동으로 이어 갑니다.`
        : hold === 'ceiling'
          ? `${ceiling.reason} 라 미션 업무를 쉽니다. 사용자 목표가 먼저입니다. 사용률이 내려가면 자동으로 이어 갑니다.`
          : m.hold === 'budget' ? '미션 예산에 여유가 생겨 다시 진행합니다.' : '구독 사용률이 내려가 다시 진행합니다.';
      appendJournal(this.paths, id, now, hold ? '사용량 대기' : '사용량 대기 해제', [`- ${text}`]);
      this.report(m, hold ? '대기' : '재개', text);
    }
    if (open.length > 0) return;
    // A stale usage figure lets one step start so its run brings back a fresh one (otherwise nothing would).
    if (hold === 'budget' || (hold === 'ceiling' && !ceiling.stale)) return;
    this.createStep(m, steps);
  }

  private createStep(m: Mission, steps: Task[]): void {
    const board = this.d.board;
    const prev = steps.at(-1);
    const prevSummary = prev ? lastLogEntry(board.readLog(prev.id), '완료보고') : '';
    const next = nextJudgement(prevSummary);
    const n = steps.length + 1;
    const title = `[${m.id}] 단계 ${n}${next ? `: ${clip(next, 60)}` : n === 1 ? `: ${clip(m.title, 60)}` : ''}`;
    const description = renderStepTemplate(this.paths, {
      id: m.id,
      title: m.title,
      n: String(n),
      mission_file: missionFile(this.paths, m.id),
      journal_file: journalFile(this.paths, m.id),
      prev: prev ? `${prev.id} ${prev.title} (${STATUS_LABEL[prev.status]}) — 결과물 ${board.taskDir(prev.id)}${path.sep}output` : '없음 (첫 단계)',
      next: next || '없음',
    });
    const task = board.createTask(this.d.config.owner, {
      title,
      description,
      assignee: this.d.config.ceo,
      doneWhen: STEP_DONE_WHEN,
      project: m.project,
      workspace: m.workspace,
      priority: 0,
      parent: null,
      mission: m.id,
    });
    updateMission(this.paths, m.id, this.d.now(), (doc) => (doc.mission.alerts = []));
    appendJournal(this.paths, m.id, this.d.now(), `단계 ${n} 시작 → ${task.id}`, [`- 제목: ${title}`]);
    this.d.log(`미션 ${m.id} 단계 ${n} → 목표 ${task.id} 등록`);
  }

  /** A step ended: record it, apply what it proposed, then check the safety limits. */
  private settleStep(m: Mission, step: Task, steps: Task[], tasks: Task[]): void {
    const board = this.d.board;
    const now = this.d.now();
    const n = steps.findIndex((t) => t.id === step.id) + 1;
    const log = board.readLog(step.id);
    const summary = step.status === 'done' ? lastLogEntry(log, '완료보고') : step.status === 'failed' ? lastLogEntry(log, '실패') || lastLogEntry(log, '반려') : lastLogEntry(log, '취소');
    const desc = descendantsOf(tasks, step.id);
    const { runs, cost } = taskRuns(this.paths, new Set([step.id, ...desc.map((t) => t.id)]));
    const doneKids = desc.filter((t) => t.status === 'done').length;
    const next = nextJudgement(summary);
    appendJournal(this.paths, m.id, now, `단계 ${n} · ${step.id} · ${STATUS_LABEL[step.status]}`, [
      `- 제목: ${step.title}`,
      `- 실행 ${runs}회, 추정 ${fmtUsd(cost)}, 하위 업무 완료 ${doneKids}/${desc.length}`,
      ...(step.mission_proposal ? [`- ${step.mission_proposal.kind === 'achieve' ? '달성 제안' : '진전 없음 선언'}: ${step.mission_proposal.text}`] : []),
      ...projectPointers(desc),
      `- 보고: ${withDecisions(summary || '(없음)', 1500)}`,
      `- 다음: ${next || '(없음)'}`,
    ]);
    this.d.log(`미션 ${m.id} 단계 ${n} (${step.id}) ${STATUS_LABEL[step.status]}`);

    if (m.status === 'stopped' || m.status === 'achieved') return;
    if (step.status === 'done' && step.mission_proposal?.kind === 'achieve') {
      this.endMission(m, 'achieved', step.mission_proposal.text);
      return;
    }
    if (step.status === 'done' && step.mission_proposal?.kind === 'stall') {
      this.pause(m, `진전 없음 (${step.id}): ${step.mission_proposal.text}`);
      return;
    }
    if (step.status === 'canceled') {
      if (m.status === 'active') this.pause(m, `단계 ${step.id} 가 취소됨. 방향을 확인한 뒤 재개해 주세요`);
      return;
    }
    const counted = steps.filter((t) => !m.resumed_at || t.created_at > m.resumed_at).filter((t) => t.id <= step.id);
    const trailing = (pred: (t: Task) => boolean) => {
      let k = 0;
      for (const t of [...counted].reverse()) {
        if (!pred(t)) break;
        k++;
      }
      return k;
    };
    const failures = trailing((t) => t.status === 'failed');
    if (failures >= this.d.config.missions.failure_streak) {
      this.pause(m, `단계가 연속 ${failures}번 실패`);
      return;
    }
    const empties = trailing((t) => t.status === 'done' && this.isEmptyStep(t, tasks));
    if (empties >= this.d.config.missions.empty_streak) {
      this.pause(m, `연속 ${empties}단계 동안 끝난 하위 업무도 산출물도 없음 (진전 없음)`);
      return;
    }
    if (m.status === 'active') {
      this.report(m, '단계', `단계 ${n} ${STATUS_LABEL[step.status]} — ${step.title}${next ? `\n다음: ${clip(next, 200)}` : ''}`, false);
    }
    if (m.status === 'active' && deadlinePassed(m, now)) this.endMission(m, 'stopped', `기한(${m.until}) 도래`);
  }

  /** Nothing delegated finished and output/ holds only paperwork. */
  private isEmptyStep(step: Task, tasks: Task[]): boolean {
    if (descendantsOf(tasks, step.id).some((t) => t.status === 'done')) return false;
    const out = path.join(this.d.board.taskDir(step.id), 'output');
    const files = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => !STEP_PAPERWORK.has(f)) : [];
    return files.length === 0;
  }

  /** Alerts while a step runs: runaway growth and long waits on the owner. Each is sent once. */
  private watchStep(m: Mission, step: Task, tasks: Task[], now: Date): void {
    const desc = descendantsOf(tasks, step.id);
    const cfg = this.d.config.missions;
    const fresh: { key: string; text: string }[] = [];
    const deepest = desc.reduce((d, t) => Math.max(d, t.depth), 0);
    if (desc.length > cfg.step_task_alert || deepest > cfg.step_depth_alert) {
      fresh.push({
        key: `runaway:${step.id}`,
        text: `단계 ${step.id} 가 커지고 있습니다: 하위 업무 ${desc.length}건, 최대 깊이 ${deepest} (경보 기준 ${cfg.step_task_alert}건·깊이 ${cfg.step_depth_alert}). 멈추지는 않습니다. 필요하면 bf mission pause ${m.id}.`,
      });
    }
    for (const w of ownerWaits(this.d.board, [step, ...desc])) {
      if (hoursSince(w.since, now) >= cfg.blocked_alert_hours) {
        fresh.push({ key: `blocked:${w.task.id}:${w.since}`, text: `${w.task.id} ${w.what} 가 ${Math.floor(hoursSince(w.since, now))}시간째 사용자를 기다립니다: ${w.task.title}` });
      }
    }
    const news = fresh.filter((f) => !m.alerts.includes(f.key));
    if (news.length === 0) return;
    updateMission(this.paths, m.id, now, (doc) => (doc.mission.alerts = [...doc.mission.alerts, ...news.map((f) => f.key)]));
    for (const f of news) this.report(m, '경보', f.text);
  }

  private pause(m: Mission, reason: string): void {
    const now = this.d.now();
    updateMission(this.paths, m.id, now, (doc) => {
      doc.mission.status = 'paused';
      doc.mission.paused_reason = reason;
    });
    m.status = 'paused';
    appendJournal(this.paths, m.id, now, '일시정지 (엔진)', [`- ${reason}`]);
    this.report(m, '일시정지', `${reason}\n재개: bf mission resume ${m.id} (웹 화면 미션 탭)`);
  }

  private endMission(m: Mission, status: 'achieved' | 'stopped', reason: string): void {
    const now = this.d.now();
    updateMission(this.paths, m.id, now, (doc) => {
      doc.mission.status = status;
      doc.mission.paused_reason = status === 'stopped' ? reason : null;
      doc.mission.ended_at = now.toISOString();
    });
    m.status = status;
    appendJournal(this.paths, m.id, now, status === 'achieved' ? '달성' : '중지 (엔진)', [`- ${reason}`]);
    this.report(m, status === 'achieved' ? '달성' : '종료', this.finalReport(m, reason));
  }

  /** Assembled from the files (no Claude run). */
  finalReport(m: Mission, reason: string): string {
    const tasks = this.d.board.list();
    const steps = missionSteps(tasks, m.id);
    const count = (s: string) => steps.filter((t) => t.status === s).length;
    const { cost } = taskRuns(this.paths, new Set(tasks.filter((t) => t.mission === m.id).map((t) => t.id)));
    const last = [...steps].reverse().find((t) => t.status === 'done');
    return [
      `사유: ${clip(reason, 800)}`,
      `단계 ${steps.length}개 (완료 ${count('done')}, 실패 ${count('failed')}, 취소 ${count('canceled')}), 누적 추정 사용량 ${fmtUsd(cost)}`,
      ...(last ? [`마지막 완료 단계 ${last.id}: ${clip(lastLogEntry(this.d.board.readLog(last.id), '완료보고'), 600)}`] : []),
      `진행 기록: ${journalFile(this.paths, m.id)}`,
    ].join('\n');
  }

  /** Event report: the owner's DM with the ceo (as a system message, so nobody replies) and a notification. */
  report(m: Mission, label: string, text: string, push = true): void {
    const body = `🧭 **미션 ${m.id} ${label}** — ${m.title}\n\n${text}`;
    postOwnerReport(this.d.paths, this.d.config, body);
    if (push) this.d.notify({ title: `미션 ${m.id} ${label}`, body: clip(text, 300) });
    this.d.log(`미션 ${m.id} ${label}: ${clip(text, 120)}`);
  }

  private dailyReport(): void {
    const stateFile = path.join(this.paths.company, '.engine-mission-report.json');
    const state: { last?: string } = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    const now = this.d.now();
    const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const last = state.last ? new Date(state.last) : end;
    if (end.getTime() <= last.getTime()) {
      if (!state.last) writeFileAtomic(stateFile, JSON.stringify({ last: end.toISOString() }));
      return;
    }
    writeFileAtomic(stateFile, JSON.stringify({ last: end.toISOString() }));
    let matches: (d: Date) => boolean;
    try {
      matches = cronMatcher(this.d.config.missions.report_cron);
    } catch (e) {
      this.d.log(`미션 보고 주기 설정 오류: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const start = Math.max(last.getTime(), end.getTime() - 86_400_000);
    let due = false;
    for (let t = start + 60_000; t <= end.getTime(); t += 60_000) if (matches(new Date(t))) due = true;
    if (!due) return;
    const text = buildDailyReport(this.d.board, this.d.config, now, state.last ?? null);
    if (!text) return;
    postOwnerReport(this.paths, this.d.config, text);
    this.d.notify({ title: '미션 정기 보고', body: '웹 화면 메신저(ceo DM) 또는 미션 탭에서 확인하세요.' });
    this.d.log('미션 정기 보고 발송');
  }
}

/** Where a step (or its subtasks) waits on the owner. */
export function ownerWaits(board: Board, tasks: Task[]): { task: Task; what: string; since: string }[] {
  const out: { task: Task; what: string; since: string }[] = [];
  for (const t of tasks) {
    if (t.status === 'blocked' && t.ask_to === board.config.owner) out.push({ task: t, what: t.approval ? '결재' : '질문', since: t.updated_at });
    else if (board.isOwnerTask(t) && t.status === 'pending') out.push({ task: t, what: '사용자 업무', since: t.created_at });
  }
  return out;
}

/** The daily report: one message for every mission that is still going. */
export function buildDailyReport(board: Board, config: Config, now: Date, since: string | null): string {
  const paths = board.paths;
  const missions = listMissions(paths).filter((m) => m.status === 'active' || m.status === 'paused' || (since && m.ended_at && m.ended_at > since));
  if (missions.length === 0) return '';
  const tasks = board.list();
  const all = listMissions(paths);
  const usage = missionUsage(paths, tasks, now.getTime() - 7 * 86_400_000);
  const parts = [`📋 **미션 정기 보고** (${now.toLocaleString()})`];
  for (const m of missions) {
    const steps = missionSteps(tasks, m.id);
    const open = steps.filter((t) => !isTerminal(t.status));
    const ended = steps.filter((t) => isTerminal(t.status) && (!since || t.updated_at > since));
    const share = missionShare(config, all, m);
    const lines = [`**${m.id} ${m.title}** — ${MISSION_STATUS_LABEL[m.status]}${m.paused_reason && m.status !== 'active' ? ` (${clip(m.paused_reason, 120)})` : ''}${m.hold ? ` · 대기: ${m.hold === 'budget' ? '예산' : '구독 사용률'}` : ''}`];
    for (const s of open) {
      const plan = path.join(board.taskDir(s.id), 'output', 'plan.md');
      const planLine = fs.existsSync(plan)
        ? fs.readFileSync(plan, 'utf8').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? ''
        : '';
      lines.push(`- 현재 단계: ${s.id} ${s.title} (${STATUS_LABEL[s.status]})${planLine ? ` — 계획: ${clip(planLine, 150)}` : ''}`);
    }
    if (ended.length) lines.push(`- 지난 보고 이후 끝난 단계: ${ended.map((t) => `${t.id} ${STATUS_LABEL[t.status]}`).join(', ')}`);
    lines.push(`- 7일 추정 사용량: ${fmtUsd(usage.get(m.id) ?? 0)}${share !== null ? ` / 몫 ${fmtUsd(share)}` : ''}`);
    const waits = open.flatMap((s) => ownerWaits(board, [s, ...descendantsOf(tasks, s.id)]));
    if (waits.length) {
      lines.push(`- 사용자를 기다리는 것: ${waits.map((w) => `${w.task.id} ${w.what} (${Math.floor(hoursSince(w.since, now))}시간)`).join(', ')}`);
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

/** Posts into the owner's DM with the ceo as a system message (kind system: no reply run, no usage). */
export function postOwnerReport(paths: Paths, config: Config, text: string): void {
  try {
    ensureDm(paths, config.owner, config.ceo);
    postMessage(paths, dmId(config.owner, config.ceo), config.ceo, text, { chain: config.chat.max_chain, kind: 'system' });
  } catch {
    // reports are best-effort; the journal keeps the record
  }
}

const FALLBACK_STEP_TEMPLATE = `이 업무는 미션 {{id}} "{{title}}"의 {{n}}번째 단계입니다. 맡긴 사람이 따로 없습니다.

- 헌장: {{mission_file}}
- 진행 기록: {{journal_file}}
- 직전 단계: {{prev}}
- 직전 단계가 넘긴 다음 판단: {{next}}

헌장과 진행 기록을 읽고 평가한 뒤 output/plan.md 에 계획을 쓰고 진행하세요. 달성이면 bf mission achieve {{id}}, 진전이 없으면 bf mission stall {{id}}.
완료 보고 요약의 마지막 줄은 '다음: <다음 단계에 넘길 판단>' 으로 쓰세요. 일반 질문은 할 수 없습니다(가정하고 진행).
`;

export function renderStepTemplate(paths: Paths, vars: Record<string, string>): string {
  const file = path.join(paths.templates, 'mission-step.md');
  const tpl = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : FALLBACK_STEP_TEMPLATE;
  return tpl.replace(/\{\{(\w+)\}\}/g, (all, k) => vars[k] ?? all).trim();
}
