import YAML from 'yaml';

export interface FrontmatterDoc {
  data: Record<string, unknown>;
  body: string;
}

/** Split a markdown file into its YAML frontmatter and body. */
export function parseFrontmatter(text: string): FrontmatterDoc {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: src };
  const afterFence = src.indexOf('\n', end + 4);
  const data = YAML.parse(src.slice(4, end)) ?? {};
  const body = afterFence === -1 ? '' : src.slice(afterFence + 1);
  return { data, body };
}

export function stringifyFrontmatter(data: object, body: string): string {
  return `---\n${YAML.stringify(data)}---\n${body}`;
}
