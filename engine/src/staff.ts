import fs from 'node:fs';
import path from 'node:path';
import { listAgents, splitToolList } from './agents.ts';
import { BoardError, checkGrantRule } from './board.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { commitCompany } from './git.ts';
import type { Paths } from './paths.ts';

const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

export interface Proposal {
  name: string;
  description: string;
  model: string | null;
  tools: string[];
  permissions: string[];
  file: string;
}

/** Validates an employee definition written by HR. Throws BoardError with the reason. */
export function validateProposal(paths: Paths, file: string): Proposal {
  if (!fs.existsSync(file)) throw new BoardError(`채용안 파일이 없습니다: ${file}`);
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const name = typeof data.name === 'string' ? data.name : '';
  if (!NAME_RE.test(name)) {
    throw new BoardError(`직원 이름은 영문 소문자로 시작하는 소문자·숫자·하이픈 2~40자여야 합니다: '${name}'`);
  }
  if (listAgents(paths).some((a) => a.name === name)) throw new BoardError(`이미 있는 직원입니다: ${name}`);
  if (typeof data.description !== 'string' || !data.description.trim()) {
    throw new BoardError(`${name}: description(한 줄 직무 설명)이 필요합니다.`);
  }
  if (body.trim().length < 50) throw new BoardError(`${name}: 직무 지침(본문)이 너무 짧습니다.`);
  const permissions = splitToolList(data.permissions);
  permissions.forEach(checkGrantRule);
  return {
    name,
    description: data.description,
    model: typeof data.model === 'string' ? data.model : null,
    tools: splitToolList(data.tools),
    permissions,
    file,
  };
}

/** Copies validated proposals into company/hiring/ to await the owner. */
export function stageProposals(paths: Paths, files: string[]): Proposal[] {
  const proposals = files.map((f) => validateProposal(paths, f));
  const names = proposals.map((p) => p.name);
  if (new Set(names).size !== names.length) throw new BoardError('같은 이름의 채용안이 중복되었습니다.');
  fs.mkdirSync(paths.hiring, { recursive: true });
  for (const p of proposals) fs.copyFileSync(p.file, path.join(paths.hiring, `${p.name}.md`));
  return proposals;
}

export function pendingProposals(paths: Paths): Proposal[] {
  if (!fs.existsSync(paths.hiring)) return [];
  return fs
    .readdirSync(paths.hiring)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const file = path.join(paths.hiring, f);
      const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      return {
        name: path.basename(f, '.md'),
        description: String(data.description ?? ''),
        model: typeof data.model === 'string' ? data.model : null,
        tools: splitToolList(data.tools),
        permissions: splitToolList(data.permissions),
        file,
      };
    });
}

/** Owner approved: move proposals onto the roster and commit, so the engine's tripwire stays quiet. */
export function installHires(paths: Paths, names: string[]): void {
  fs.mkdirSync(paths.agents, { recursive: true });
  for (const name of names) {
    const src = path.join(paths.hiring, `${name}.md`);
    validateProposal(paths, src);
    fs.renameSync(src, path.join(paths.agents, `${name}.md`));
  }
  commitCompany(paths, `채용 승인: ${names.join(', ')}`);
}

export function discardHires(paths: Paths, names: string[]): void {
  for (const name of names) fs.rmSync(path.join(paths.hiring, `${name}.md`), { force: true });
}
