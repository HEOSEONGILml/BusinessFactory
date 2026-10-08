import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './board.ts';
import { withLock, writeFileAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

/**
 * Company messenger: channels, DMs and meeting rooms.
 * Each conversation is <id>.json (metadata) + <id>.jsonl (messages) under company/chat/.
 * Talk only — real work still goes through goals and tasks.
 */

export type ConvKind = 'channel' | 'dm' | 'meeting';

export interface Conversation {
  id: string;
  kind: ConvKind;
  title: string;
  /** Who belongs here. Channels: everyone (empty list). DMs: the two parties. Meetings: owner + participants. */
  members: string[];
  project: string | null;
  created_at: string;
  /** Meetings only. */
  status?: 'open' | 'closing' | 'closed';
  agenda?: string;
  facilitator?: string;
  /** Meetings: who speaks next, in order. */
  queue?: string[];
  /** Meetings: agent turns used since the owner last spoke (caps runaway discussion). */
  turns_since_owner?: number;
  notes_file?: string | null;
}

export interface Message {
  id: string;
  at: string;
  from: string;
  text: string;
  mentions: string[];
  /** 0 = from the owner; each agent reply to a chain-n message is n+1. Long chains stop triggering replies. */
  chain: number;
  kind: 'text' | 'system' | 'summary';
}

const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;

function chatDir(paths: Paths): string {
  return path.join(paths.company, 'chat');
}

function lockFile(paths: Paths): string {
  return path.join(paths.company, '.chat-lock');
}

function convFile(paths: Paths, id: string, ext: 'json' | 'jsonl'): string {
  if (!/^[cdm]-[\p{L}\p{N}_.-]+$/u.test(id)) throw new BoardError(`잘못된 대화 id: ${id}`);
  return path.join(chatDir(paths), `${id}.${ext}`);
}

export function getConv(paths: Paths, id: string): Conversation {
  const file = convFile(paths, id, 'json');
  if (!fs.existsSync(file)) throw new BoardError(`없는 대화입니다: ${id}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveConv(paths: Paths, conv: Conversation): void {
  fs.mkdirSync(chatDir(paths), { recursive: true });
  writeFileAtomic(convFile(paths, conv.id, 'json'), JSON.stringify(conv, null, 2));
}

export function listConvs(paths: Paths): Conversation[] {
  const dir = chatDir(paths);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Conversation);
}

export function ensureChannel(paths: Paths, name: string, project: string | null = null): Conversation {
  const clean = name.replace(/^#/, '').trim().toLowerCase();
  if (!SAFE_NAME.test(clean)) throw new BoardError(`채널 이름은 글자·숫자·하이픈만 쓸 수 있습니다: ${name}`);
  const id = `c-${clean}`;
  if (fs.existsSync(convFile(paths, id, 'json'))) return getConv(paths, id);
  const conv: Conversation = { id, kind: 'channel', title: `#${clean}`, members: [], project, created_at: new Date().toISOString() };
  saveConv(paths, conv);
  return conv;
}

export function dmId(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `d-${x}--${y}`;
}

export function ensureDm(paths: Paths, a: string, b: string): Conversation {
  if (a === b) throw new BoardError('자기 자신에게는 DM을 보낼 수 없습니다.');
  for (const n of [a, b]) if (!SAFE_NAME.test(n)) throw new BoardError(`잘못된 이름: ${n}`);
  const id = dmId(a, b);
  if (fs.existsSync(convFile(paths, id, 'json'))) return getConv(paths, id);
  const conv: Conversation = { id, kind: 'dm', title: `${a} ↔ ${b}`, members: [a, b].sort(), project: null, created_at: new Date().toISOString() };
  saveConv(paths, conv);
  return conv;
}

export function createMeeting(
  paths: Paths,
  input: { title: string; agenda: string; participants: string[]; owner: string; facilitator: string },
): Conversation {
  const title = input.title.trim() || '회의';
  const participants = [...new Set(input.participants)];
  if (participants.length === 0) throw new BoardError('참석자를 한 명 이상 고르세요.');
  if (!input.agenda.trim()) throw new BoardError('안건을 적어 주세요.');
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const id = `m-${stamp}-${randomBytes(2).toString('hex')}`;
  const facilitator = participants.includes(input.facilitator) ? input.facilitator : participants[0];
  const conv: Conversation = {
    id,
    kind: 'meeting',
    title,
    members: [input.owner, ...participants],
    project: null,
    created_at: now.toISOString(),
    status: 'open',
    agenda: input.agenda.trim(),
    facilitator,
    queue: [],
    turns_since_owner: 0,
    notes_file: null,
  };
  saveConv(paths, conv);
  postMessage(paths, id, input.owner, `**안건: ${title}**\n\n${input.agenda.trim()}`, { chain: 0 });
  return getConv(paths, id);
}

export function parseMentions(text: string, names: string[]): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    const n = m[1].toLowerCase();
    if (n === 'all' || n === '모두') names.forEach((x) => found.add(x));
    else if (names.includes(n)) found.add(n);
  }
  return [...found];
}

export function postMessage(
  paths: Paths,
  convId: string,
  from: string,
  text: string,
  opts: { chain: number; kind?: Message['kind']; names?: string[] },
): Message {
  const body = text.trim();
  if (!body) throw new BoardError('메시지가 비어 있습니다.');
  if (body.length > 20_000) throw new BoardError('메시지가 너무 깁니다.');
  const conv = getConv(paths, convId);
  if (conv.kind === 'dm' && !conv.members.includes(from)) throw new BoardError('이 DM의 참여자가 아닙니다.');
  if (conv.kind === 'meeting' && conv.status === 'closed') throw new BoardError('끝난 회의입니다.');
  const msg: Message = {
    id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    at: new Date().toISOString(),
    from,
    text: body,
    mentions: parseMentions(body, opts.names ?? []),
    chain: opts.chain,
    kind: opts.kind ?? 'text',
  };
  fs.mkdirSync(chatDir(paths), { recursive: true });
  withLock(lockFile(paths), () => {
    fs.appendFileSync(convFile(paths, convId, 'jsonl'), JSON.stringify(msg) + '\n', 'utf8');
  });
  return msg;
}

export function readMessages(paths: Paths, convId: string, limit = 200): Message[] {
  const file = convFile(paths, convId, 'jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l));
}

export function lastMessage(paths: Paths, convId: string): Message | null {
  return readMessages(paths, convId, 1)[0] ?? null;
}

/**
 * "#name" → channel, "@agent" → DM between actor and agent, otherwise a conversation id.
 */
export function resolveTarget(paths: Paths, target: string, actor: string, agentNames: string[]): Conversation {
  if (target.startsWith('#')) return ensureChannel(paths, target);
  if (target.startsWith('@')) {
    const who = target.slice(1).toLowerCase();
    if (!agentNames.includes(who) && who !== 'owner') throw new BoardError(`없는 직원입니다: ${who}`);
    return ensureDm(paths, actor, who);
  }
  return getConv(paths, target);
}

/** Readable transcript for prompts: "[10:21] owner: ...". */
export function transcript(messages: Message[]): string {
  return messages
    .map((m) => {
      const t = new Date(m.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
      const tag = m.kind === 'summary' ? ' (회의록)' : m.kind === 'system' ? ' (안내)' : '';
      return `[${t}] ${m.from}${tag}: ${m.text}`;
    })
    .join('\n');
}

// ---------- who should answer what (engine side) ----------

export type Cursors = Record<string, Record<string, string>>;

export function readCursors(paths: Paths): Cursors {
  const file = path.join(chatDir(paths), '.cursors.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

export function writeCursor(paths: Paths, convId: string, agent: string, messageId: string): void {
  const all = readCursors(paths);
  (all[convId] ??= {})[agent] = messageId;
  fs.mkdirSync(chatDir(paths), { recursive: true });
  writeFileAtomic(path.join(chatDir(paths), '.cursors.json'), JSON.stringify(all, null, 2));
}

export interface DueReply {
  convId: string;
  agent: string;
  /** Newest message this reply covers; becomes the agent's cursor. */
  upTo: string;
  chain: number;
}

/**
 * Agents owed a reply outside meetings: the other party of a DM, or anyone @mentioned in a
 * channel, for messages newer than what they last answered. Chains at maxChain stop here,
 * so agents cannot keep each other talking forever.
 */
export function dueReplies(paths: Paths, agents: string[], maxChain: number): DueReply[] {
  const cursors = readCursors(paths);
  const due: DueReply[] = [];
  for (const conv of listConvs(paths)) {
    if (conv.kind === 'meeting') continue;
    const msgs = readMessages(paths, conv.id, 100);
    if (msgs.length === 0) continue;
    const candidates = conv.kind === 'dm' ? conv.members.filter((m) => agents.includes(m)) : agents;
    for (const agent of candidates) {
      const seen = cursors[conv.id]?.[agent];
      const start = seen ? msgs.findIndex((m) => m.id === seen) + 1 : 0;
      const fresh = msgs.slice(start).filter((m) => m.from !== agent && m.kind === 'text' && m.chain < maxChain);
      const relevant = conv.kind === 'dm' ? fresh : fresh.filter((m) => m.mentions.includes(agent));
      if (relevant.length === 0) continue;
      due.push({ convId: conv.id, agent, upTo: msgs[msgs.length - 1].id, chain: Math.max(...relevant.map((m) => m.chain)) });
    }
  }
  return due;
}

export function meetingNotesDir(paths: Paths): string {
  return path.join(paths.company, 'meetings');
}

// ---------- meeting flow (owner side) ----------

function participants(conv: Conversation, agentNames: string[]): string[] {
  const list = conv.members.filter((m) => agentNames.includes(m));
  // The facilitator opens each round.
  return conv.facilitator && list.includes(conv.facilitator) ? [conv.facilitator, ...list.filter((m) => m !== conv.facilitator)] : list;
}

/** The owner spoke: whoever they @mentioned answers, otherwise everyone takes a turn. */
export function ownerSpokeInMeeting(paths: Paths, convId: string, mentions: string[], agentNames: string[]): Conversation {
  const conv = getConv(paths, convId);
  const all = participants(conv, agentNames);
  const named = all.filter((m) => mentions.includes(m));
  conv.queue = named.length ? named : all;
  conv.turns_since_owner = 0;
  saveConv(paths, conv);
  return conv;
}

export function meetingNextRound(paths: Paths, convId: string, agentNames: string[]): Conversation {
  const conv = getConv(paths, convId);
  if (conv.kind !== 'meeting' || conv.status !== 'open') throw new BoardError('진행 중인 회의가 아닙니다.');
  conv.queue = participants(conv, agentNames);
  conv.turns_since_owner = 0;
  saveConv(paths, conv);
  return conv;
}

export function endMeeting(paths: Paths, convId: string): Conversation {
  const conv = getConv(paths, convId);
  if (conv.kind !== 'meeting' || conv.status !== 'open') throw new BoardError('진행 중인 회의가 아닙니다.');
  conv.status = 'closing';
  conv.queue = [];
  saveConv(paths, conv);
  return conv;
}
