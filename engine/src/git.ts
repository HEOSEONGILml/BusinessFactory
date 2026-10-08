import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Paths } from './paths.ts';

function git(cwd: string, ...args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

export function companyHasGit(paths: Paths): boolean {
  return fs.existsSync(path.join(paths.company, '.git'));
}

/** Commits everything in the company folder (no-op without git or without changes). */
export function commitCompany(paths: Paths, message: string): void {
  if (!companyHasGit(paths)) return;
  git(paths.company, 'add', '-A');
  git(paths.company, '-c', 'user.name=BusinessFactory', '-c', 'user.email=bf@localhost', 'commit', '-q', '-m', message);
}

/**
 * Uncommitted changes under company/staff. Staff only changes through owner-approved
 * hiring, which commits immediately — so anything here is suspicious.
 * Returns null when the company folder has no git.
 */
export function staffChanges(paths: Paths): string | null {
  if (!companyHasGit(paths)) return null;
  const r = git(paths.company, 'status', '--porcelain', '--', path.relative(paths.company, paths.agents));
  return r.status === 0 ? r.stdout.trim() : null;
}

/** git status of the system's own code (null if the root is not a git repo). */
export function systemStatus(paths: Paths, areas: string[]): string | null {
  const r = git(paths.root, 'status', '--porcelain', '--', ...areas);
  return r.status === 0 ? r.stdout : null;
}
