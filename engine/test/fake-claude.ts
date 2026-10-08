/**
 * Stand-in for `claude -p` in engine tests. Behaviour per employee comes from
 * FAKE_PLAN (JSON: agent name → behaviour). Every invocation is appended to FAKE_LOG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { Board } from '../src/board.ts';
import { loadConfig } from '../src/config.ts';
import { resolvePaths } from '../src/paths.ts';

const args = process.argv.slice(2);
const agent = args[args.indexOf('--agent') + 1];
const taskId = process.env.BF_TASK!;
const plan: Record<string, string> = JSON.parse(process.env.FAKE_PLAN ?? '{}');
const behaviour = plan[agent] ?? 'done';
const prompt = fs.readFileSync(0, 'utf8');

const paths = resolvePaths(process.env);
const board = new Board(paths, loadConfig(paths));
const task = board.read(taskId).task;

if (process.env.FAKE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_LOG,
    JSON.stringify({
      agent,
      task: taskId,
      cwd: process.cwd(),
      args,
      prompt,
      hasApiKey: 'ANTHROPIC_API_KEY' in process.env,
      pathHasBin: (process.env.PATH ?? process.env.Path ?? '').includes(paths.bin),
      actor: process.env.BF_ACTOR,
    }) + '\n',
  );
}

const bf = (...a: string[]) => {
  const code = main(a, process.env, { out: () => {}, err: (s) => process.stderr.write(s + '\n') });
  if (code !== 0) throw new Error(`bf ${a.join(' ')} failed`);
};

function reply(result: string, extra: Record<string, unknown> = {}) {
  // Mimic --output-format stream-json: activity and usage events, then the result line.
  const line = (o: object) => process.stdout.write(JSON.stringify(o) + '\n');
  line({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Write', input: { file_path: path.join(process.cwd(), 'output', 'result.md') } },
        { type: 'text', text: `${agent} 작업 중` },
      ],
    },
  });
  const util = Number(process.env.FAKE_UTIL ?? '0.1');
  line({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: util, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { utilization: 0.2, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
      },
    },
  });
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result,
      session_id: `fake-${agent}-${taskId}`,
      num_turns: 2,
      duration_ms: 10,
      total_cost_usd: 0.01,
      modelUsage: { 'claude-fake': {} },
      permission_denials: [],
      ...extra,
    }) + '\n',
  );
}

switch (behaviour) {
  case 'delegate': {
    // First run: hand work to a worker. Second run (woken after it finishes): report.
    if (board.children(taskId).length === 0) {
      bf('task', 'create', '--to', 'worker', '--title', `${task.title} - 실무`, '--done-when', 'result.md 존재');
      reply('위임함');
    } else {
      fs.writeFileSync(path.join('output', 'report.md'), '취합 보고서');
      bf('task', 'done', taskId, '--summary', '취합 완료');
      reply('보고함');
    }
    break;
  }
  case 'done':
    fs.writeFileSync(path.join('output', 'result.md'), '결과');
    bf('task', 'done', taskId, '--summary', '완료');
    reply('완료함');
    break;
  case 'pass':
    bf('task', 'pass', taskId, '--note', 'ok');
    reply('통과');
    break;
  case 'reject-once':
    if (task.rejections === 0) bf('task', 'reject', taskId, '보완 필요');
    else bf('task', 'pass', taskId);
    reply('판정함');
    break;
  case 'silent':
    reply('아무것도 보고하지 않음');
    break;
  case 'limit':
    reply("You've hit your session limit · resets 3:45pm", { is_error: true });
    process.exitCode = 1;
    break;
  case 'auth':
    reply('Failed to authenticate. API Error: 401', { is_error: true, api_error_status: 401 });
    process.exitCode = 1;
    break;
  default:
    throw new Error(`unknown behaviour ${behaviour}`);
}
