import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitToolList } from '../src/agents.ts';
import type { AgentInfo } from '../src/agents.ts';
import { buildAllowedTools, buildEnv, isUsageLimit, parseResetTime, toRulePath } from '../src/runner.ts';

function agent(tools: string[], permissions: string[] = []): AgentInfo {
  return { name: 'a', description: '', model: null, tools, permissions, prompt: '', file: '' };
}

describe('권한 규칙', () => {
  it('경로를 Claude Code 규칙 형식으로 바꾼다', () => {
    if (process.platform === 'win32') {
      assert.equal(toRulePath('C:\\Users\\x\\company\\board\\T0001'), '//c/Users/x/company/board/T0001');
    } else {
      assert.equal(toRulePath('/home/x/company'), '//home/x/company');
    }
  });

  it('파일 권한은 항상 경로로 제한하고, 경로 없는 파일 권한은 버린다', () => {
    const rules = buildAllowedTools(agent(['Read', 'Write', 'WebSearch'], ['WebSearch', 'Write', 'Bash(npm:*)']), {
      write: ['/w/task'],
      read: ['/w/board'],
    });
    assert.ok(rules.includes('Bash(bf:*)'));
    assert.ok(rules.includes('Bash(npm:*)'));
    assert.ok(rules.includes('WebSearch'));
    assert.ok(!rules.includes('Write'));
    assert.ok(rules.some((r) => r.startsWith('Edit(') && r.endsWith('task/**)')));
    assert.ok(!rules.some((r) => r.startsWith('Edit(') && r.includes('board')));
  });

  it('읽기 전용 직원에게는 쓰기 규칙을 주지 않는다', () => {
    const rules = buildAllowedTools(agent(['Read', 'Grep']), { write: ['/w/task'], read: [] });
    assert.ok(!rules.some((r) => r.startsWith('Edit(')));
  });

  it('도구 목록을 괄호를 깨지 않고 나눈다', () => {
    assert.deepEqual(splitToolList('Read, Bash(git log:*, x), Write'), ['Read', 'Bash(git log:*, x)', 'Write']);
    assert.deepEqual(splitToolList(['Read', ' Grep ']), ['Read', 'Grep']);
  });
});

describe('실행 환경', () => {
  it('API 키와 상위 세션 변수를 지우고 bin 을 PATH 앞에 둔다', () => {
    const env = buildEnv(
      { ANTHROPIC_API_KEY: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', PATH: '/usr/bin', HOME: '/h' },
      { binDir: '/sys/bin', env: { BF_TASK: 'T0001' } },
    );
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.ok(env.PATH!.startsWith('/sys/bin'));
    assert.equal(env.HOME, '/h');
    assert.equal(env.BF_TASK, 'T0001');
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  });
});

describe('사용량 한도', () => {
  it('한도 메시지를 감지한다', () => {
    assert.ok(isUsageLimit({ text: "You've hit your session limit · resets 3:45pm", stderr: '' }));
    assert.ok(isUsageLimit({ text: '', stderr: "You've hit your weekly Opus limit · resets Mon 12:00am" }));
    assert.ok(!isUsageLimit({ text: 'Server is temporarily limiting requests (not your usage limit)', stderr: '' }));
  });

  it('리셋 시각을 계산한다', () => {
    const now = new Date(2026, 9, 8, 14, 0); // 목요일 14:00
    const today = parseResetTime('resets 3:45pm', now);
    assert.equal(today.getDate(), 8);
    assert.equal(today.getHours(), 15);
    assert.equal(today.getMinutes(), 47); // 2분 여유

    const tomorrow = parseResetTime('resets 9am', now);
    assert.equal(tomorrow.getDate(), 9);

    const monday = parseResetTime('resets Mon 12:00am', now);
    assert.equal(monday.getDay(), 1);
    assert.equal(monday.getDate(), 12);

    const unknown = parseResetTime('soon', now);
    assert.equal(unknown.getTime() - now.getTime(), 60 * 60_000);
  });
});
