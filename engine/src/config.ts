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
  /** Deepest allowed delegation; goals are depth 0. null = no limit (missions rely on usage and failure limits instead). */
  max_depth: number | null;
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
  /**
   * Stop starting new work when a subscription window's used share reaches this (0..1).
   * Leaves room for the owner's own Claude use. Windows: five_hour, seven_day.
   */
  usage_ceiling: Record<string, number>;
  /**
   * Slow down before the ceiling: once a window's used share reaches `at[window]` (0..1), at most
   * `max_concurrency` work/review runs go at once (instead of the usual max_concurrency).
   * Keep `at` below usage_ceiling, or the full stop comes first.
   */
  usage_throttle: { at: Record<string, number>; max_concurrency: number };
  /** Messenger and meetings: replies run as short employee runs (read-only unless full_access). */
  chat: {
    max_concurrency: number;
    /** Agent-to-agent reply chains stop after this many hops. */
    max_chain: number;
    max_turns: number;
    timeout_minutes: number;
    /** In a meeting, agent turns allowed per participant before the owner must speak again. */
    meeting_turns_per_participant: number;
  };
  /**
   * Local web console started with the engine. allowed_hosts: extra Host headers accepted
   * besides localhost (e.g. a Tailscale name), as "host" or "host:port".
   */
  web: { enabled: boolean; port: number; open_browser: boolean; allowed_hosts: string[] };
  /** How the owner is told that something needs them. */
  notify: NotifyConfig;
  /** Command that starts Claude Code; extra elements are leading arguments. */
  claude_command: string[];
  /** Model for employees whose definition names none. */
  default_model: string | null;
  /**
   * Work and review runs skip every permission check (bypassPermissions) instead of the
   * path-scoped allow list. Messenger and comment replies then run with the same full access.
   */
  full_access: boolean;
  /**
   * Tasks on a git workspace each work in their own worktree (branch bf/<id>) and merge back into
   * the workspace's checked-out branch at `bf task done`, so they can run side by side. Off: one
   * task per workspace at a time.
   */
  worktrees: boolean;
  /**
   * Self-recovery. auto_resume_minutes: after a halt, switch back on by itself after this long
   * (doubling each time in a row, up to 6 hours; 0 = wait for the owner). stale_seconds: `bf engine-check`
   * reports the engine as hung when its heartbeat is older than this.
   */
  watchdog: { auto_resume_minutes: number; stale_seconds: number };
  /**
   * The owner delegated their decisions: approval requests (actions and hires) are approved on the
   * spot and recorded, and the ceo may run the owner's mission commands (create, pause, resume, stop, set).
   */
  autonomy: boolean;
  /** Missions: quarter-sized directions the company pursues step by step on its own (docs/MISSIONS.md). */
  missions: MissionsConfig;
  /** Every workspace gets a private GitHub remote and its work is pushed there (engine/src/remote.ts). */
  workspace_remote: WorkspaceRemoteConfig;
}

export interface WorkspaceRemoteConfig {
  /**
   * On: the engine makes a new workspace a git repo, creates a PRIVATE GitHub repo (gh) for every
   * workspace repo without origin and pushes it, and `bf task done` pushes the merged base branch.
   * Pushes only go to remotes gh reports as private. Off by default (needs a logged-in gh).
   */
  enabled: boolean;
  /** GitHub account or organisation for new repos (<owner>/<workspace>); null = the gh account. */
  owner: string | null;
  /** Command that runs the GitHub CLI; extra elements are leading arguments. */
  gh_command: string[];
}

export const DEFAULT_WORKSPACE_REMOTE: WorkspaceRemoteConfig = { enabled: false, owner: null, gh_command: ['gh'] };

export interface MissionsConfig {
  /**
   * Estimated usage (usage.jsonl cost_usd_estimate) all missions may spend in a moving 7-day window.
   * Each active mission gets budget × weight / Σ active weights; over its share its work waits. null = no budget.
   */
  weekly_budget_usd: number | null;
  /** Subscription seven_day share at which mission work stops starting (room left for the owner's own goals). */
  seven_day_ceiling: number;
  /** A usage snapshot older than this lets one mission run through to refresh it (hours). */
  probe_after_hours: number;
  /** Run slots mission work may hold at once. null = max_concurrency - 1 (at least 1). */
  max_slots: number | null;
  /** Failed steps in a row that pause a mission. */
  failure_streak: number;
  /** Empty steps (nothing delegated finished, no output besides plan/report) in a row that pause a mission. */
  empty_streak: number;
  /** Tell the owner (without stopping) when one step grows past this many tasks or this depth. */
  step_task_alert: number;
  step_depth_alert: number;
  /** Tell the owner when a step has waited on them (approval, question, owner task) this long (hours). */
  blocked_alert_hours: number;
  /** When the daily mission report goes to the owner (cron, local time). */
  report_cron: string;
}

export const DEFAULT_MISSIONS: MissionsConfig = {
  weekly_budget_usd: 300,
  seven_day_ceiling: 0.7,
  probe_after_hours: 6,
  max_slots: null,
  failure_streak: 2,
  empty_streak: 2,
  step_task_alert: 40,
  step_depth_alert: 10,
  blocked_alert_hours: 24,
  report_cron: '0 9 * * *',
};

export const DEFAULT_CONFIG: Config = {
  owner: 'owner',
  ceo: 'ceo',
  reviewer: 'reviewer',
  max_depth: null,
  max_attempts: 3,
  max_rejections: 3,
  max_concurrency: 2,
  max_turns: 60,
  run_timeout_minutes: 30,
  poll_seconds: 5,
  project_priority: {},
  notify: DEFAULT_NOTIFY,
  usage_ceiling: { five_hour: 0.95, seven_day: 0.95 },
  usage_throttle: { at: { five_hour: 0.9, seven_day: 0.9 }, max_concurrency: 1 },
  web: { enabled: true, port: 4300, open_browser: true, allowed_hosts: [] },
  chat: { max_concurrency: 2, max_chain: 3, max_turns: 12, timeout_minutes: 5, meeting_turns_per_participant: 2 },
  claude_command: ['claude'],
  default_model: null,
  full_access: false,
  worktrees: false,
  watchdog: { auto_resume_minutes: 10, stale_seconds: 120 },
  autonomy: false,
  missions: DEFAULT_MISSIONS,
  workspace_remote: DEFAULT_WORKSPACE_REMOTE,
};

export function loadConfig(paths: Paths): Config {
  if (!fs.existsSync(paths.config)) return { ...DEFAULT_CONFIG };
  const raw = YAML.parse(fs.readFileSync(paths.config, 'utf8')) ?? {};
  return { ...DEFAULT_CONFIG, ...raw, notify: { ...DEFAULT_NOTIFY, ...(raw.notify ?? {}) },
    usage_ceiling: { ...DEFAULT_CONFIG.usage_ceiling, ...(raw.usage_ceiling ?? {}) },
    usage_throttle: {
      ...DEFAULT_CONFIG.usage_throttle,
      ...(raw.usage_throttle ?? {}),
      at: { ...DEFAULT_CONFIG.usage_throttle.at, ...(raw.usage_throttle?.at ?? {}) },
    },
    web: { ...DEFAULT_CONFIG.web, ...(raw.web ?? {}) },
    chat: { ...DEFAULT_CONFIG.chat, ...(raw.chat ?? {}) },
    watchdog: { ...DEFAULT_CONFIG.watchdog, ...(raw.watchdog ?? {}) },
    missions: { ...DEFAULT_MISSIONS, ...(raw.missions ?? {}) },
    workspace_remote: { ...DEFAULT_WORKSPACE_REMOTE, ...(raw.workspace_remote ?? {}) },
  };
}
