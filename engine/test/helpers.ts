import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Board } from '../src/board.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { resolvePaths } from '../src/paths.ts';

export const AGENTS = ['ceo', 'hr', 'reviewer', 'worker'];

/** A throwaway system root with the default employees defined. */
export function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-test-'));
  const agentsDir = path.join(root, 'company', 'staff');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of AGENTS) {
    fs.writeFileSync(
      path.join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: test ${name}\nmodel: sonnet\n---\n테스트 직원\n`,
    );
  }
  return root;
}

export function makeBoard(overrides: Partial<Config> = {}): { board: Board; root: string } {
  const root = makeRoot();
  const paths = resolvePaths({ BF_ROOT: root });
  return { board: new Board(paths, { ...DEFAULT_CONFIG, ...overrides }), root };
}

export const DONE_WHEN = ['결과물이 output/ 에 있다'];
