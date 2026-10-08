import fs from 'node:fs';
import path from 'node:path';
import { listAgents, splitToolList } from './agents.ts';
import { BoardError, checkGrantRule } from './board.ts';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.ts';
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

// ---------- owner edits from the web console ----------

/** Tools an employee definition may list (file tools are path-scoped by the engine). */
export const KNOWN_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite'];
const MODEL_RE = /^(opus|sonnet|haiku|fable|claude-[a-z0-9.-]+)$/;

export interface StaffInput {
  name: string;
  description: string;
  model: string | null;
  tools: string[];
  permissions: string[];
  prompt: string;
}

export function readStaff(paths: Paths, name: string): StaffInput & { file: string } {
  const agent = listAgents(paths).find((a) => a.name === name);
  if (!agent) throw new BoardError(`없는 직원입니다: ${name}`);
  return {
    name: agent.name,
    description: agent.description,
    model: agent.model,
    tools: agent.tools,
    permissions: agent.permissions,
    prompt: agent.prompt,
    file: agent.file,
  };
}

/**
 * Owner creates or edits an employee. Same safety rules as hiring (no disk-wide permissions),
 * and the change is committed at once so the engine's roster tripwire stays quiet.
 */
export function saveStaff(paths: Paths, input: StaffInput, create: boolean): void {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) throw new BoardError(`직원 이름은 영문 소문자로 시작하는 소문자·숫자·하이픈 2~40자여야 합니다: '${name}'`);
  const exists = listAgents(paths).some((a) => a.name === name);
  if (create && exists) throw new BoardError(`이미 있는 직원입니다: ${name}`);
  if (!create && !exists) throw new BoardError(`없는 직원입니다: ${name}`);
  if (!input.description.trim()) throw new BoardError('직무 설명(한 줄)이 필요합니다.');
  if (input.prompt.trim().length < 20) throw new BoardError('직무 지침이 너무 짧습니다.');
  const model = input.model?.trim() || null;
  if (model && !MODEL_RE.test(model)) throw new BoardError(`알 수 없는 모델: ${model}`);
  const tools = [...new Set(input.tools.map((t) => t.trim()).filter(Boolean))];
  const unknown = tools.filter((t) => !KNOWN_TOOLS.includes(t));
  if (unknown.length) throw new BoardError(`알 수 없는 도구: ${unknown.join(', ')}`);
  const permissions = [...new Set(input.permissions.map((p) => p.trim()).filter(Boolean))];
  permissions.forEach(checkGrantRule);

  const front: Record<string, string> = { name, description: input.description.trim().replace(/\n/g, ' ') };
  if (model) front.model = model;
  if (tools.length) front.tools = tools.join(', ');
  if (permissions.length) front.permissions = permissions.join(', ');
  fs.mkdirSync(paths.agents, { recursive: true });
  fs.writeFileSync(path.join(paths.agents, `${name}.md`), stringifyFrontmatter(front, input.prompt.trim() + '\n'), 'utf8');
  validateSaved(paths, name);
  commitCompany(paths, `${create ? '직원 추가' : '직원 수정'}: ${name} (사용자)`);
}

function validateSaved(paths: Paths, name: string): void {
  const a = listAgents(paths).find((x) => x.name === name);
  if (!a) throw new BoardError('저장한 직원 파일을 다시 읽지 못했습니다.');
}

/** Owner removes an employee. The CEO and reviewer roles cannot be removed; nor anyone with open work. */
export function removeStaff(paths: Paths, name: string, protectedNames: string[], openAssignments: number): void {
  if (protectedNames.includes(name)) throw new BoardError(`${name} 는 회사 운영에 꼭 필요한 직원이라 내보낼 수 없습니다. 설정만 바꿀 수 있습니다.`);
  if (openAssignments > 0) throw new BoardError(`${name} 에게 아직 끝나지 않은 업무가 ${openAssignments}건 있습니다. 먼저 끝내거나 취소하세요.`);
  const file = path.join(paths.agents, `${name}.md`);
  if (!fs.existsSync(file)) throw new BoardError(`없는 직원입니다: ${name}`);
  fs.rmSync(file);
  commitCompany(paths, `직원 내보냄: ${name} (사용자)`);
}
