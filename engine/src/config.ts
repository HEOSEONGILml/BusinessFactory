import fs from 'node:fs';
import YAML from 'yaml';
import { DEFAULT_NOTIFY } from './notify.ts';
import type { NotifyConfig } from './notify.ts';
import type { Paths } from './paths.ts';

export interface Config {
  /** Name the human owner acts under. */
  owner: string;
  /** Agent that receives top-level goals. */
  ceo: string;
  /** Agent that reviews finished work. */
  reviewer: string;
  /** Deepest allowed delegation; goals are depth 0. */
  max_depth: number;
  max_attempts: number;
  max_rejections: number;
  /** How many employees may run at once (they share one subscription allowance). */
  max_concurrency: number;
  /** Turn cap for a single employee run. */
  max_turns: number;
  /** A run still going after this long is killed and counted as a failed attempt. */
  run_timeout_minutes: number;
  /** How often the engine looks at the board. */
  poll_seconds: number;
  /** Added to the priority of every task in that project (where to spend the allowance first). */
  project_priority: Record<string, number>;
  /** How the owner is told that something needs them. */
  notify: NotifyConfig;
  /** Command that starts Claude Code; extra elements are leading arguments. */
  claude_command: string[];
}

export const DEFAULT_CONFIG: Config = {
  owner: 'owner',
  ceo: 'ceo',
  reviewer: 'reviewer',
  max_depth: 3,
  max_attempts: 3,
  max_rejections: 3,
  max_concurrency: 2,
  max_turns: 60,
  run_timeout_minutes: 30,
  poll_seconds: 5,
  project_priority: {},
  notify: DEFAULT_NOTIFY,
  claude_command: ['claude'],
};

export function loadConfig(paths: Paths): Config {
  if (!fs.existsSync(paths.config)) return { ...DEFAULT_CONFIG };
  const raw = YAML.parse(fs.readFileSync(paths.config, 'utf8')) ?? {};
  return { ...DEFAULT_CONFIG, ...raw, notify: { ...DEFAULT_NOTIFY, ...(raw.notify ?? {}) } };
}
