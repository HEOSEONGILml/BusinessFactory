import fs from 'node:fs';
import path from 'node:path';
import type { Paths } from './paths.ts';

export interface UsageEntry {
  at: string;
  task: string;
  project: string | null;
  kind: 'work' | 'review';
  agent: string;
  models: string[];
  turns: number;
  duration_ms: number;
  cost_usd_estimate: number;
  error: boolean;
}

export function readUsage(paths: Paths): UsageEntry[] {
  const file = path.join(paths.company, 'usage.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Runs, turns and time per agent and per project. The cost column is Claude Code's
 * API-price estimate; on a subscription it is only a relative measure of how much allowance was used.
 */
export function printUsage(paths: Paths, days: number, out: (s: string) => void): void {
  const since = Date.now() - days * 86_400_000;
  const entries = readUsage(paths).filter((e) => Date.parse(e.at) >= since);
  if (entries.length === 0) {
    out(`최근 ${days}일 실행 기록이 없습니다.`);
    return;
  }
  const table = (label: string, key: (e: UsageEntry) => string) => {
    const groups = new Map<string, UsageEntry[]>();
    for (const e of entries) groups.set(key(e), [...(groups.get(key(e)) ?? []), e]);
    out(`\n${label.padEnd(18)} ${'실행'.padStart(4)} ${'턴'.padStart(5)} ${'시간(분)'.padStart(8)} ${'상대비용'.padStart(8)} 오류`);
    for (const [k, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      const sum = (f: (e: UsageEntry) => number) => list.reduce((acc, e) => acc + f(e), 0);
      out(
        `${k.padEnd(18)} ${String(list.length).padStart(4)} ${String(sum((e) => e.turns)).padStart(5)} ` +
          `${(sum((e) => e.duration_ms) / 60_000).toFixed(1).padStart(8)} ${('$' + sum((e) => e.cost_usd_estimate).toFixed(2)).padStart(8)} ` +
          `${list.filter((e) => e.error).length}`,
      );
    }
  };
  out(`최근 ${days}일: 실행 ${entries.length}회`);
  table('직원', (e) => e.agent);
  table('프로젝트', (e) => e.project ?? '(없음)');
  out('\n※ 상대비용은 API 가격 기준 추정치입니다. 구독에서는 실제 청구가 아니라 사용량 비교용입니다.');
}
