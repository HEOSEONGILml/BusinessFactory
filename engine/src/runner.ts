import { spawn } from 'node:child_process';
import path from 'node:path';
import type { AgentInfo } from './agents.ts';
import { parseStreamLine } from './stream.ts';
import type { RunEvent } from './stream.ts';

/** Tools that read files; their access is granted per directory through Read rules. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
/** Tools that change files; granted per directory through Edit rules. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Converts an absolute path to Claude Code's permission-rule form:
 * "C:\a\b" → "//c/a/b", "/a/b" → "//a/b".
 * (A bare tool name like "Write" would grant access to the whole disk — never emit one.)
 */
export function toRulePath(abs: string): string {
  const fwd = abs.split(path.sep).join('/').replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(fwd);
  if (drive) return `//${drive[1].toLowerCase()}/${drive[2]}`.replace(/\/+$/, '');
  return `/${fwd}`.replace(/\/+$/, '');
}

export interface Access {
  /** Directories the employee may change. */
  write: string[];
  /** Directories the employee may only read. */
  read: string[];
}

/**
 * The --allowedTools list for one run. File access is always path-scoped;
 * everything else comes from the agent's own `permissions`.
 */
export function buildAllowedTools(agent: AgentInfo, access: Access, grants: string[] = []): string[] {
  const rules = new Set<string>(['Bash(bf:*)']);
  const usesFiles = agent.tools.length === 0 || agent.tools.some((t) => READ_TOOLS.has(t) || EDIT_TOOLS.has(t));
  const canEdit = agent.tools.length === 0 || agent.tools.some((t) => EDIT_TOOLS.has(t));
  if (usesFiles) {
    for (const dir of [...access.write, ...access.read]) rules.add(`Read(${toRulePath(dir)}/**)`);
  }
  if (canEdit) {
    for (const dir of access.write) rules.add(`Edit(${toRulePath(dir)}/**)`);
  }
  for (const rule of [...agent.permissions, ...grants]) {
    if (READ_TOOLS.has(rule) || EDIT_TOOLS.has(rule)) continue; // would be disk-wide
    rules.add(rule);
  }
  return [...rules];
}

/** The tool list an agent is defined with; Bash is always present so it can reach bf. */
export function agentToolList(agent: AgentInfo): string[] | undefined {
  if (agent.tools.length === 0) return undefined; // Claude Code default: all tools
  const names = new Set(agent.tools.map((t) => t.replace(/\(.*$/, '')));
  names.add('Bash');
  return [...names];
}

export interface RunSpec {
  command: string[];
  agent: AgentInfo;
  /** File given to --agents (written by the caller). */
  agentsFile: string;
  prompt: string;
  cwd: string;
  access: Access;
  handbook: string | null;
  maxTurns: number;
  timeoutMs: number;
  /** Owner-approved permission rules for this task only. */
  grants: string[];
  /** Extra environment for the employee (BF_ACTOR, BF_TASK, ...). */
  env: Record<string, string>;
  /** Prepended to PATH so the employee can call `bf`. */
  binDir: string;
  /** Live activity and usage while the employee works. */
  onEvent?: (e: RunEvent) => void;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  isError: boolean;
  /** The employee's final message, or the error text. */
  text: string;
  sessionId: string | null;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  models: string[];
  denials: string[];
  apiErrorStatus: number | null;
  stderr: string;
}

export function buildArgs(spec: RunSpec): string[] {
  const args = [
    '-p',
    '--agents', spec.agentsFile,
    '--agent', spec.agent.name,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--max-turns', String(spec.maxTurns),
    '--allowedTools', ...buildAllowedTools(spec.agent, spec.access, spec.grants),
  ];
  // The working directory is already trusted; extra dirs must be added explicitly.
  for (const dir of [...spec.access.write, ...spec.access.read]) {
    if (path.resolve(dir) !== path.resolve(spec.cwd)) args.push('--add-dir', dir);
  }
  if (spec.handbook) args.push('--append-system-prompt-file', spec.handbook);
  return args;
}

/**
 * Environment for an employee run. Strips anything that would make the child
 * authenticate with an API key (we run on the subscription login) or think it
 * is nested inside this Claude Code session.
 */
export function buildEnv(base: NodeJS.ProcessEnv, spec: Pick<RunSpec, 'env' | 'binDir'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(k)) continue;
    env[k] = v;
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = spec.binDir + path.delimiter + (env[pathKey] ?? '');
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return { ...env, ...spec.env };
}

export function runAgent(spec: RunSpec, baseEnv: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  const [cmd, ...lead] = spec.command;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, [...lead, ...buildArgs(spec)], {
      cwd: spec.cwd,
      env: buildEnv(baseEnv, spec),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let pending = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      if (!spec.onEvent) return;
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        for (const ev of parseStreamLine(line, spec.cwd)) {
          try {
            spec.onEvent(ev);
          } catch {
            // Observers must never break a run.
          }
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, spec.timeoutMs);
    // The prompt goes through stdin so quotes and newlines survive on every platform.
    child.stdin.end(spec.prompt);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve(parseRunOutput(stdout, stderr, exitCode, timedOut, Date.now() - started));
    };
    child.on('error', (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on('close', finish);
  });
}

export function parseRunOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean,
  elapsedMs: number,
): RunResult {
  const base: RunResult = {
    exitCode,
    timedOut,
    isError: true,
    text: '',
    sessionId: null,
    costUsd: 0,
    numTurns: 0,
    durationMs: elapsedMs,
    models: [],
    denials: [],
    apiErrorStatus: null,
    stderr: stderr.trim(),
  };
  // stream-json ends with a {"type":"result"} line; plain json is just that line.
  let json: Record<string, unknown> | null = null;
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'result') {
        json = parsed;
        break;
      }
    } catch {
      // not JSON (or a partial line from a killed process)
    }
  }
  if (!json) {
    return { ...base, text: timedOut ? '실행 시간 초과' : (stderr.trim() || '결과 없음') };
  }
  const denials = Array.isArray(json!.permission_denials) ? json!.permission_denials : [];
  return {
    ...base,
    isError: timedOut || json!.is_error === true || exitCode !== 0,
    text: typeof json!.result === 'string' ? json!.result : '',
    sessionId: typeof json!.session_id === 'string' ? json!.session_id : null,
    costUsd: typeof json!.total_cost_usd === 'number' ? json!.total_cost_usd : 0,
    numTurns: typeof json!.num_turns === 'number' ? json!.num_turns : 0,
    durationMs: typeof json!.duration_ms === 'number' ? json!.duration_ms : elapsedMs,
    models: Object.keys((json!.modelUsage as object | undefined) ?? {}),
    denials: denials.map((d: { tool_name?: string; tool_input?: Record<string, unknown> }) => {
      const input = d.tool_input ?? {};
      const detail = input.command ?? input.file_path ?? input.path ?? '';
      return `${d.tool_name ?? '?'} ${String(detail)}`.trim();
    }),
    apiErrorStatus: typeof json!.api_error_status === 'number' ? json!.api_error_status : null,
  };
}

const LIMIT_RE = /You['’]ve hit your [\w\s]*limit/i;
const RESET_RE = /resets\s+(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function isUsageLimit(r: Pick<RunResult, 'text' | 'stderr'>): boolean {
  return LIMIT_RE.test(r.text) || LIMIT_RE.test(r.stderr);
}

/**
 * When a usage limit lifts, from text like "resets 3:45pm" or "resets Mon 12:00am"
 * (local time). Unparseable → one hour from now. Adds a small safety margin.
 */
export function parseResetTime(text: string, now: Date): Date {
  const margin = 2 * 60_000;
  const m = RESET_RE.exec(text);
  if (!m) return new Date(now.getTime() + 60 * 60_000);
  let hour = Number(m[2]);
  const minute = m[3] ? Number(m[3]) : 0;
  const ampm = m[4]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (m[1]) {
    const want = WEEKDAYS.indexOf(m[1].toLowerCase());
    const diff = (want - target.getDay() + 7) % 7;
    target.setDate(target.getDate() + diff);
  }
  while (target.getTime() <= now.getTime()) target.setDate(target.getDate() + (m[1] ? 7 : 1));
  return new Date(target.getTime() + margin);
}
