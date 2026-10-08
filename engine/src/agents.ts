import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';
import type { Paths } from './paths.ts';

export interface AgentInfo {
  name: string;
  description: string;
  model: string | null;
  /** Claude Code tools this employee may use at all (frontmatter `tools`). */
  tools: string[];
  /**
   * Extra permission rules beyond what the engine grants by default
   * (frontmatter `permissions`), e.g. "Bash(npm:*)", "WebSearch".
   */
  permissions: string[];
  /** The job description: the file body, used as the agent's system prompt. */
  prompt: string;
  file: string;
}

/** Splits "Read, Bash(git log:*), Write" without breaking inside parentheses. */
export function splitToolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Employees are Claude Code subagent definitions in company/staff/. */
export function listAgents(paths: Paths): AgentInfo[] {
  if (!fs.existsSync(paths.agents)) return [];
  return fs
    .readdirSync(paths.agents)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const file = path.join(paths.agents, f);
      const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      return {
        name: typeof data.name === 'string' ? data.name : path.basename(f, '.md'),
        description: typeof data.description === 'string' ? data.description : '',
        model: typeof data.model === 'string' ? data.model : null,
        tools: splitToolList(data.tools),
        permissions: splitToolList(data.permissions),
        prompt: body.trim(),
        file,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgent(paths: Paths, name: string): AgentInfo | null {
  return listAgents(paths).find((a) => a.name === name) ?? null;
}
