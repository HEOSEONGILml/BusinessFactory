import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_CONFIG } from './config.ts';
import { commitCompany } from './git.ts';
import type { Paths } from './paths.ts';

export interface InitResult {
  created: string[];
  git: 'initialized' | 'skipped' | 'exists' | 'unavailable';
}

const SCHEDULES_TEMPLATE = `# 정기 업무. 엔진이 시각에 맞춰 목표를 자동 등록한다.
# cron: "분 시 일 월 요일" (로컬 시각). 예: "0 9 * * 1" = 매주 월요일 09:00
#
# schedules:
#   - id: weekly-report
#     cron: "0 9 * * 1"
#     goal: "지난주 회사 업무를 정리해 주간 보고서를 작성"
#     project: null      # 선택
#     priority: 0        # 선택
schedules: []
`;

/** Creates the company data folder from templates. Safe to re-run: never overwrites existing files. */
export function initCompany(paths: Paths, opts: { git: boolean }): InitResult {
  const created: string[] = [];
  for (const dir of [paths.company, paths.board, paths.agents, paths.hiring, paths.memory, paths.workspaces]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  const files: Record<string, string> = {
    [paths.config]: '# 회사 설정. 비어 있는 항목은 기본값을 따른다.\n' + YAML.stringify({ ...DEFAULT_CONFIG, project_priority: {} }),
    [path.join(paths.company, 'schedules.yaml')]: SCHEDULES_TEMPLATE,
    [path.join(paths.memory, 'index.md')]: '# 회사 기억 목차\n',
    [path.join(paths.company, '.gitignore')]: '.lock\n.engine/\n.engine-schedule.json\n.engine-notified.json\n.run/\n*.tmp\n',
  };
  const handbookTemplate = path.join(paths.templates, 'handbook.md');
  if (fs.existsSync(handbookTemplate)) files[paths.handbook] = fs.readFileSync(handbookTemplate, 'utf8');
  const staffTemplates = path.join(paths.templates, 'staff');
  if (fs.existsSync(staffTemplates)) {
    for (const f of fs.readdirSync(staffTemplates).filter((n) => n.endsWith('.md'))) {
      files[path.join(paths.agents, f)] = fs.readFileSync(path.join(staffTemplates, f), 'utf8');
    }
  }
  for (const [file, content] of Object.entries(files)) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, content, 'utf8');
      created.push(file);
    }
  }

  let git: InitResult['git'] = 'skipped';
  if (opts.git) {
    if (fs.existsSync(path.join(paths.company, '.git'))) {
      git = 'exists';
    } else if (spawnSync('git', ['-C', paths.company, 'init', '-q']).status !== 0) {
      git = 'unavailable';
    } else {
      git = 'initialized';
    }
    if (git !== 'unavailable') commitCompany(paths, created.length ? '회사 설립' : '설정 갱신');
  }
  return { created, git };
}
