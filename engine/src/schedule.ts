import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { writeFileAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

export interface Schedule {
  id: string;
  cron: string;
  goal: string;
  project?: string | null;
  priority?: number;
}

/** Parses one cron field ("*", "5", "1-5", "*\/15", "1,3,5") into the set of allowed values. */
function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      lo = a;
      hi = b ?? (stepRaw ? max : a);
    }
    if (![lo, hi, step].every(Number.isInteger) || lo < min || hi > max || step < 1) {
      throw new Error(`잘못된 cron 필드: ${field}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function cronMatcher(expr: string): (d: Date) => boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 은 5개 필드여야 합니다: ${expr}`);
  const [min, hour, dom, mon, dow] = [
    parseField(fields[0], 0, 59),
    parseField(fields[1], 0, 23),
    parseField(fields[2], 1, 31),
    parseField(fields[3], 1, 12),
    parseField(fields[4].replace(/7/g, '0'), 0, 6),
  ];
  const domAny = fields[2] === '*';
  const dowAny = fields[4] === '*';
  return (d) => {
    if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !mon.has(d.getMonth() + 1)) return false;
    // Standard cron: when both day fields are restricted, either may match.
    const domOk = dom.has(d.getDate());
    const dowOk = dow.has(d.getDay());
    if (domAny && dowAny) return true;
    if (domAny) return dowOk;
    if (dowAny) return domOk;
    return domOk || dowOk;
  };
}

export function loadSchedules(paths: Paths): Schedule[] {
  const file = path.join(paths.company, 'schedules.yaml');
  if (!fs.existsSync(file)) return [];
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw?.schedules) ? raw.schedules : [];
}

/**
 * Schedules that fired in (lastCheck, now]. State lives in company/.engine-schedule.json so a
 * restart neither repeats nor (within a day) skips a run.
 */
export function dueSchedules(paths: Paths, now: Date): Schedule[] {
  const stateFile = path.join(paths.company, '.engine-schedule.json');
  const state: { last?: string } = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const floorMinute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);
  const end = floorMinute(now);
  // First run ever: start from now (don't replay history). Cap catch-up at one day.
  const last = state.last ? new Date(state.last) : end;
  const start = new Date(Math.max(last.getTime(), end.getTime() - 86_400_000));
  writeFileAtomic(stateFile, JSON.stringify({ last: end.toISOString() }));
  if (end <= start) return [];

  const due: Schedule[] = [];
  for (const s of loadSchedules(paths)) {
    const matches = cronMatcher(s.cron);
    for (let t = start.getTime() + 60_000; t <= end.getTime(); t += 60_000) {
      if (matches(new Date(t))) {
        due.push(s);
        break; // one goal per schedule per pass, even after a long pause
      }
    }
  }
  return due;
}
