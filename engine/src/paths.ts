import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every location the system reads or writes, resolved once. */
export interface Paths {
  root: string;
  bin: string;
  templates: string;
  workspaces: string;
  company: string;
  board: string;
  /** Employee definitions (Claude Code subagent format). */
  agents: string;
  hiring: string;
  memory: string;
  config: string;
  handbook: string;
  lock: string;
  nextId: string;
}

/**
 * BF_ROOT overrides the system root (defaults to the repo this file lives in);
 * BF_COMPANY overrides the company data folder (defaults to <root>/company),
 * BF_WORKSPACES the workspaces folder (defaults to <root>/workspaces).
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const root = env.BF_ROOT
    ? path.resolve(env.BF_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const company = env.BF_COMPANY ? path.resolve(env.BF_COMPANY) : path.join(root, 'company');
  const board = path.join(company, 'board');
  return {
    root,
    bin: path.join(root, 'bin'),
    templates: path.join(root, 'templates'),
    workspaces: env.BF_WORKSPACES ? path.resolve(env.BF_WORKSPACES) : path.join(root, 'workspaces'),
    company,
    board,
    agents: path.join(company, 'staff'),
    hiring: path.join(company, 'hiring'),
    memory: path.join(company, 'memory'),
    config: path.join(company, 'config.yaml'),
    handbook: path.join(company, 'handbook.md'),
    lock: path.join(company, '.lock'),
    nextId: path.join(board, '.next-id'),
  };
}
