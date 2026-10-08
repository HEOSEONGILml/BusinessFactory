import fs from 'node:fs';
import path from 'node:path';
import type { Paths } from './paths.ts';
import { WINDOW_LABEL } from './stream.ts';
import type { UsageSnapshot } from './stream.ts';

/** Latest subscription usage the engine saw, if any. */
export function readUsageSnapshot(paths: Paths): (UsageSnapshot & { at: string }) | null {
  const file = path.join(paths.company, '.engine-usage.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function formatUsageSnapshot(snap: UsageSnapshot & { at: string }): string {
  const parts = Object.entries(snap.windows).map(([name, w]) => {
    const reset = new Date(w.resetsAt * 1000).toLocaleString();
    return `${WINDOW_LABEL[name] ?? name} ${Math.round(w.utilization * 100)}% (리셋 ${reset})`;
  });
  return `구독 사용량: ${parts.join(' · ')}  [${new Date(snap.at).toLocaleTimeString()} 기준]`;
}

/** Last line of a task's activity.log, as "<what> (<n>초 전)". */
export function lastActivity(taskDir: string, now = Date.now()): string | null {
  const file = path.join(taskDir, 'activity.log');
  if (!fs.existsSync(file)) return null;
  const last = fs.readFileSync(file, 'utf8').trimEnd().split('\n').pop();
  const m = last && /^(\S+) \[[^\]]+\] (.*)$/.exec(last);
  if (!m) return null;
  const secs = Math.max(0, Math.round((now - Date.parse(m[1])) / 1000));
  const ago = secs < 60 ? `${secs}초 전` : `${Math.round(secs / 60)}분 전`;
  return `${m[2]} (${ago})`;
}

/** `bf watch [task]`: show recent engine log lines, then follow new ones. */
export async function watch(paths: Paths, filter: string | null, signal: AbortSignal): Promise<void> {
  const file = path.join(paths.company, 'engine.log');
  const show = (text: string) => {
    for (const line of text.split('\n')) {
      if (line && (!filter || line.includes(filter))) console.log(line);
    }
  };
  let offset = 0;
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    show(text.split('\n').slice(-30).join('\n'));
    offset = Buffer.byteLength(text, 'utf8');
  }
  console.log(`--- 실시간 보기 중${filter ? ` (${filter})` : ''}. 끝내려면 Ctrl+C ---`);
  let carry = '';
  while (!signal.aborted) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    if (size < offset) offset = 0; // log was rotated or cleared
    if (size === offset) continue;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const text = carry + buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    carry = cut === -1 ? text : text.slice(cut + 1);
    if (cut !== -1) show(text.slice(0, cut));
  }
}
