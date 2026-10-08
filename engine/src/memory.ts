import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './board.ts';
import { withLock, writeFileAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export interface MemoryTopic {
  topic: string;
  title: string;
  file: string;
  entries: number;
}

/**
 * Company memory: one markdown file per topic plus a generated index.md.
 * Employees can only read the folder; they add entries through bf.
 */
export function addMemory(
  paths: Paths,
  input: { topic: string; text: string; title?: string; actor: string; task: string | null; at: Date },
): MemoryTopic {
  const topic = input.topic.trim().toLowerCase();
  if (!TOPIC_RE.test(topic)) {
    throw new BoardError(`주제 이름은 영문 소문자·숫자·하이픈이어야 합니다 (예: deploy-checklist): '${input.topic}'`);
  }
  if (!input.text.trim()) throw new BoardError('기억할 내용이 비어 있습니다.');
  fs.mkdirSync(paths.memory, { recursive: true });
  return withLock(paths.lock, () => {
    const file = path.join(paths.memory, `${topic}.md`);
    const isNew = !fs.existsSync(file);
    if (isNew && !input.title?.trim()) {
      throw new BoardError(`새 주제입니다. --title 로 제목을 정해 주세요. (기존 주제는 bf memory list)`);
    }
    const head = isNew ? `# ${input.title!.trim()}\n` : fs.readFileSync(file, 'utf8');
    const stamp = `${input.at.toISOString().slice(0, 10)} · ${input.actor}${input.task ? ` · ${input.task}` : ''}`;
    writeFileAtomic(file, `${head.trimEnd()}\n\n## ${stamp}\n\n${input.text.trim()}\n`);
    writeIndex(paths);
    return listMemory(paths).find((t) => t.topic === topic)!;
  });
}

export function listMemory(paths: Paths): MemoryTopic[] {
  if (!fs.existsSync(paths.memory)) return [];
  return fs
    .readdirSync(paths.memory)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .sort()
    .map((f) => {
      const file = path.join(paths.memory, f);
      const text = fs.readFileSync(file, 'utf8');
      return {
        topic: path.basename(f, '.md'),
        title: /^# (.+)$/m.exec(text)?.[1].trim() ?? path.basename(f, '.md'),
        file,
        entries: (text.match(/^## /gm) ?? []).length,
      };
    });
}

export function readMemory(paths: Paths, topic: string): string {
  const file = path.join(paths.memory, `${topic}.md`);
  if (!TOPIC_RE.test(topic) || !fs.existsSync(file)) throw new BoardError(`없는 주제입니다: ${topic}`);
  return fs.readFileSync(file, 'utf8');
}

function writeIndex(paths: Paths): void {
  const lines = listMemory(paths).map((t) => `- [${t.title}](${t.topic}.md) — ${t.entries}건`);
  writeFileAtomic(path.join(paths.memory, 'index.md'), `# 회사 기억 목차\n\n${lines.join('\n')}\n`);
}
