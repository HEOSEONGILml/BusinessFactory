import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMeeting,
  dueReplies,
  endMeeting,
  ensureChannel,
  ensureDm,
  getConv,
  ownerSpokeInMeeting,
  parseMentions,
  postMessage,
  readMessages,
  resolveTarget,
  writeCursor,
} from '../src/chat.ts';
import { main } from '../src/cli.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { resolvePaths } from '../src/paths.ts';
import { runAgent } from '../src/runner.ts';
import { AGENTS, makeRoot } from './helpers.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.ts', import.meta.url));

function setup(plan: Record<string, string> = {}, overrides: Partial<Config> = {}) {
  const root = makeRoot();
  const paths = resolvePaths({ BF_ROOT: root });
  const fakeLog = path.join(root, 'fake.jsonl');
  const config: Config = { ...DEFAULT_CONFIG, claude_command: [process.execPath, FAKE], ...overrides };
  const engine = new Engine(paths, config, {
    log: () => {},
    notify: () => {},
    run: (spec) => runAgent(spec, { ...process.env, FAKE_PLAN: JSON.stringify(plan), FAKE_LOG: fakeLog }),
  });
  const calls = () =>
    fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { root, paths, engine, calls };
}

const say = (paths: ReturnType<typeof resolvePaths>, conv: string, from: string, text: string, chain = 0) =>
  postMessage(paths, conv, from, text, { chain, names: AGENTS });

describe('메신저 데이터', () => {
  it('멘션을 직원 이름으로만 인식하고 @all 은 모두', () => {
    assert.deepEqual(parseMentions('@ceo 와 @nobody, @worker 봐줘', AGENTS), ['ceo', 'worker']);
    assert.deepEqual(parseMentions('@all 공지', AGENTS).sort(), [...AGENTS].sort());
  });

  it('채널·DM 대상 해석, DM 은 참여자만 쓸 수 있다', () => {
    const { paths } = setup();
    assert.equal(resolveTarget(paths, '#General', 'owner', AGENTS).id, 'c-general');
    const dm = resolveTarget(paths, '@ceo', 'worker', AGENTS);
    assert.equal(dm.id, 'd-ceo--worker');
    assert.throws(() => say(paths, dm.id, 'hr', '끼어들기'), /참여자가 아닙니다/);
    assert.throws(() => resolveTarget(paths, '@ghost', 'owner', AGENTS), /없는 직원/);
    assert.throws(() => ensureChannel(paths, '../etc'), /채널 이름/);
  });

  it('답장할 사람: DM 상대, 채널에서 불린 직원. 본 메시지와 긴 연쇄는 제외', () => {
    const { paths } = setup();
    const dm = ensureDm(paths, 'owner', 'ceo');
    say(paths, dm.id, 'owner', '안녕');
    const ch = ensureChannel(paths, 'general');
    say(paths, ch.id, 'owner', '그냥 공지');
    say(paths, ch.id, 'owner', '@worker 확인 부탁');
    const due = dueReplies(paths, AGENTS, 3);
    assert.deepEqual(due.map((d) => `${d.convId}:${d.agent}`).sort(), ['c-general:worker', 'd-ceo--owner:ceo']);

    for (const d of due) writeCursor(paths, d.convId, d.agent, d.upTo);
    assert.equal(dueReplies(paths, AGENTS, 3).length, 0);

    say(paths, ch.id, 'hr', '@worker 이것도', 3);
    assert.equal(dueReplies(paths, AGENTS, 3).length, 0, '연쇄 한도에 닿은 메시지는 답장을 부르지 않는다');
  });
});

describe('메신저 실행', () => {
  it('사용자 DM 에 직원이 답하고, 대화 실행은 읽기 전용이다', async () => {
    const { paths, engine, calls } = setup();
    const dm = ensureDm(paths, 'owner', 'ceo');
    say(paths, dm.id, 'owner', '이번 주 어때?');
    await engine.runUntilIdle();
    const msgs = readMessages(paths, dm.id);
    assert.deepEqual(msgs.map((m) => m.from), ['owner', 'ceo']);
    assert.equal(msgs[1].text, 'ceo 의견입니다');
    assert.equal(msgs[1].chain, 1);

    const c = calls()[0];
    assert.equal(c.chat, dm.id);
    const i = c.args.indexOf('--allowedTools');
    const rules: string[] = [];
    for (let j = i + 1; j < c.args.length && !c.args[j].startsWith('--'); j++) rules.push(c.args[j]);
    assert.ok(!rules.some((r) => r.startsWith('Edit(')), '대화에는 쓰기 권한이 없다');
    assert.ok(!rules.some((r) => r.includes('workspaces')), '작업 공간(비밀값)은 읽지 못한다');

    await engine.runUntilIdle();
    assert.equal(readMessages(paths, dm.id).length, 2, '같은 메시지에 두 번 답하지 않는다');
  });

  it('직원끼리 서로 부르는 대화는 연쇄 한도에서 멈춘다', async () => {
    const { paths, engine, calls } = setup({ 'chat:ceo': 'mention:worker', 'chat:worker': 'mention:ceo' }, {
      chat: { ...DEFAULT_CONFIG.chat, max_chain: 3 },
    });
    const ch = ensureChannel(paths, 'general');
    say(paths, ch.id, 'owner', '@ceo 의견 주세요');
    await engine.runUntilIdle();
    const msgs = readMessages(paths, ch.id);
    assert.deepEqual(msgs.map((m) => `${m.from}:${m.chain}`), ['owner:0', 'ceo:1', 'worker:2', 'ceo:3']);
    assert.equal(calls().length, 3);
  });

  it('회의: 진행자부터 차례로 발언하고, 종료하면 회의록을 남긴다', async () => {
    const { paths, engine } = setup({ 'chat:hr': 'pass' });
    const conv = createMeeting(paths, { title: '우선순위', agenda: '무엇부터?', participants: ['worker', 'ceo', 'hr'], owner: 'owner', facilitator: 'ceo' });
    ownerSpokeInMeeting(paths, conv.id, [], AGENTS);
    assert.deepEqual(getConv(paths, conv.id).queue, ['ceo', 'worker', 'hr']);

    await engine.runUntilIdle();
    assert.deepEqual(readMessages(paths, conv.id).map((m) => m.from), ['owner', 'ceo', 'worker'], 'hr 은 패스');
    assert.deepEqual(getConv(paths, conv.id).queue, []);

    // 사용자가 한 명만 부르면 그 사람만 답한다
    const msg = say(paths, conv.id, 'owner', '@worker 근거는?');
    ownerSpokeInMeeting(paths, conv.id, msg.mentions, AGENTS);
    await engine.runUntilIdle();
    assert.deepEqual(readMessages(paths, conv.id).slice(-2).map((m) => m.from), ['owner', 'worker']);

    endMeeting(paths, conv.id);
    await engine.runUntilIdle();
    const done = getConv(paths, conv.id);
    assert.equal(done.status, 'closed');
    const last = readMessages(paths, conv.id).pop()!;
    assert.equal(last.kind, 'summary');
    assert.equal(last.from, 'ceo');
    const notes = fs.readFileSync(path.join(paths.company, done.notes_file!), 'utf8');
    assert.match(notes, /# 우선순위[\s\S]*## 할 일[\s\S]*## 대화 기록/);
    assert.throws(() => say(paths, conv.id, 'owner', '늦은 의견'), /끝난 회의/);
  });

  it('회의 중 직원이 다른 참석자를 부르면 차례가 추가되지만 발언 한도를 넘지 않는다', async () => {
    const { paths, engine } = setup({ 'chat:ceo': 'mention:worker', 'chat:worker': 'mention:ceo' }, {
      chat: { ...DEFAULT_CONFIG.chat, meeting_turns_per_participant: 2 },
    });
    const conv = createMeeting(paths, { title: '토론', agenda: '논쟁', participants: ['ceo', 'worker'], owner: 'owner', facilitator: 'ceo' });
    ownerSpokeInMeeting(paths, conv.id, [], AGENTS);
    await engine.runUntilIdle();
    const agentTurns = readMessages(paths, conv.id).filter((m) => m.from !== 'owner').length;
    assert.equal(agentTurns, 4, '참석자 2명 × 2회');
  });
});

describe('bf chat 명령', () => {
  it('직원이 채널에 글을 쓰고 DM 을 읽는다', () => {
    const root = makeRoot();
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
    assert.equal(main(['chat', 'post', '#blindcandle', '배포', '준비', '완료'], { BF_ROOT: root, BF_ACTOR: 'worker' }, io), 0);
    assert.equal(main(['dm', 'ceo', '@ceo', '검토', '부탁'], { BF_ROOT: root, BF_ACTOR: 'worker' }, io), 0);
    assert.equal(main(['chat', 'read', '@worker'], { BF_ROOT: root, BF_ACTOR: 'ceo' }, io), 0);
    assert.match(out.join('\n'), /worker: @ceo 검토 부탁/);
    const paths = resolvePaths({ BF_ROOT: root });
    assert.equal(readMessages(paths, 'c-blindcandle')[0].chain, 1, '직원 글은 이미 연쇄 1단계');
  });
});
