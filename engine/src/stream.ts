import path from 'node:path';

/** Subscription allowance as reported by Claude Code (`rate_limit_event`). */
export interface UsageWindow {
  /** 0..1 share of the window's allowance already used. */
  utilization: number;
  /** Epoch seconds when the window resets. */
  resetsAt: number;
}

export interface UsageSnapshot {
  status: string;
  windows: Record<string, UsageWindow>;
}

export type RunEvent =
  | { kind: 'activity'; text: string }
  | { kind: 'usage'; usage: UsageSnapshot };

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** Short, human-readable description of one tool call. */
export function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => {
    if (typeof p !== 'string') return '';
    const r = path.relative(cwd, p);
    return r && !r.startsWith('..') ? r : p;
  };
  switch (name) {
    case 'Bash':
      return `$ ${clip(String(input.command ?? ''), 120)}`;
    case 'Read':
      return `읽기 ${rel(input.file_path)}`;
    case 'Write':
      return `쓰기 ${rel(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `수정 ${rel(input.file_path)}`;
    case 'Glob':
      return `파일 찾기 ${clip(String(input.pattern ?? ''), 80)}`;
    case 'Grep':
      return `내용 검색 "${clip(String(input.pattern ?? ''), 60)}"`;
    case 'WebSearch':
      return `웹 검색 "${clip(String(input.query ?? ''), 80)}"`;
    case 'WebFetch':
      return `웹 열람 ${clip(String(input.url ?? ''), 100)}`;
    case 'TodoWrite':
      return '할 일 목록 정리';
    default:
      return `${name}`;
  }
}

/** Turns one line of `--output-format stream-json` into zero or more events. */
export function parseStreamLine(line: string, cwd: string): RunEvent[] {
  let j: Record<string, any>;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    const out: RunEvent[] = [];
    for (const c of j.message.content) {
      if (c.type === 'tool_use') out.push({ kind: 'activity', text: describeTool(c.name, c.input ?? {}, cwd) });
      else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        out.push({ kind: 'activity', text: `💬 ${clip(c.text, 140)}` });
      }
    }
    return out;
  }
  if (j.type === 'rate_limit_event' && j.rate_limit_info) {
    const info = j.rate_limit_info;
    const windows: Record<string, UsageWindow> = {};
    for (const [k, v] of Object.entries<any>(info.unifiedWindows ?? {})) {
      if (typeof v?.utilization === 'number') windows[k] = { utilization: v.utilization, resetsAt: Number(v.resetsAt) };
    }
    return [{ kind: 'usage', usage: { status: String(info.status ?? 'unknown'), windows } }];
  }
  return [];
}

export const WINDOW_LABEL: Record<string, string> = { five_hour: '5시간', seven_day: '주간' };
