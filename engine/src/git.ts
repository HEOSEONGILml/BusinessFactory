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
