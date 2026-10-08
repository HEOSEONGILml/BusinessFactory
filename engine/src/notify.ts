import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Board, Task } from './board.ts';
import { isTerminal } from './board.ts';
import { writeFileAtomic } from './fsutil.ts';
import type { Paths } from './paths.ts';

export interface NotifyConfig {
  /** Windows toast notifications on this PC. */
  desktop: boolean;
  /**
   * Optional phone push through ntfy.sh (free app, no account). Anyone who knows the topic
   * name can read the messages, so use a long random name. null = off.
   */
  ntfy_topic: string | null;
}

export const DEFAULT_NOTIFY: NotifyConfig = { desktop: true, ntfy_topic: null };

export interface Notice {
  title: string;
  body: string;
}

export type Sender = (n: Notice) => void;

// Text arrives through environment variables so nothing in it is ever parsed as PowerShell.
const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $xml.GetElementsByTagName('text')
$null = $t.Item(0).AppendChild($xml.CreateTextNode($env:BF_NOTIFY_TITLE))
$null = $t.Item(1).AppendChild($xml.CreateTextNode($env:BF_NOTIFY_BODY))
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

function desktopSender(): Sender {
  return (n) => {
    if (process.platform !== 'win32') return;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT], {
      env: { ...process.env, BF_NOTIFY_TITLE: n.title, BF_NOTIFY_BODY: n.body },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
  };
}

function ntfySender(topic: string): Sender {
  return (n) => {
    fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title: n.title, message: n.body }),
    }).catch(() => {});
  };
}

export function buildSender(cfg: NotifyConfig, log: (s: string) => void): Sender {
  const senders: Sender[] = [];
  if (cfg.desktop) senders.push(desktopSender());
  if (cfg.ntfy_topic) senders.push(ntfySender(cfg.ntfy_topic));
  return (n) => {
    log(`알림: ${n.title} — ${n.body}`);
    for (const s of senders) {
      try {
        s(n);
      } catch {
        // A broken notifier must never stop the company.
      }
    }
  };
}

/**
 * Things only the owner can move forward. Each gets one notice: the key changes only
 * when there is something new to say (a new request, a new final state).
 */
export function ownerItems(board: Board): { key: string; notice: Notice }[] {
  const owner = board.config.owner;
  const items: { key: string; notice: Notice }[] = [];
  for (const t of board.list()) {
    if (t.status === 'blocked' && t.ask_to === owner) {
      const key = `${t.id}:blocked:${t.updated_at}`;
      if (!t.approval && t.questions?.length) {
        // One notice per open item, so each request stands on its own.
        for (const q of t.questions.filter((x) => x.answer === null)) {
          items.push({
            key: `${t.id}:q${q.id}:${t.questions.length}`,
            notice: { title: `질문 · ${t.id} (${q.id}/${t.questions.length})`, body: `${q.text.slice(0, 200)}\n→ 웹 화면 또는 bf task answer ${num(t)} --item ${q.id} "답"` },
          });
        }
        continue;
      }
      if (t.approval) {
        items.push({ key, notice: { title: `결재 요청 · ${t.id}`, body: `${t.approval.what}\n→ bf approve ${num(t)} / bf deny ${num(t)} "사유"` } });
      } else {
        items.push({ key, notice: { title: `질문 · ${t.id}`, body: `${lastQuestion(board, t)}\n→ bf task answer ${num(t)} "답"` } });
      }
    } else if (board.isOwnerTask(t) && t.status === 'pending') {
      items.push({
        key: `${t.id}:mine`,
        notice: { title: `사용자 업무 · ${t.id} · ${t.created_by}`, body: `${t.title}\n→ 웹 화면 처리할 일, 또는 bf task done ${num(t)} --summary "결과"` },
      });
    } else if (t.parent === null && isTerminal(t.status) && !t.acknowledged && t.status !== 'canceled') {
      const done = t.status === 'done';
      items.push({
        key: `${t.id}:${t.status}`,
        notice: { title: `${done ? '목표 완료' : '목표 실패'} · ${t.id}`, body: `${t.title}\n→ bf task show ${num(t)}` },
      });
    }
  }
  return items;
}

/** Remembers which owner items were already announced (company/.engine-notified.json). */
export class OwnerNotifier {
  private readonly file: string;
  private readonly send: Sender;
  private seen: Set<string>;

  constructor(paths: Paths, send: Sender) {
    this.file = path.join(paths.company, '.engine-notified.json');
    this.send = send;
    this.seen = new Set(fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : []);
  }

  check(board: Board): void {
    const items = ownerItems(board);
    const fresh = items.filter((i) => !this.seen.has(i.key));
    for (const i of fresh) this.send(i.notice);
    // Keep only keys still relevant so the file never grows without bound.
    const current = new Set(items.map((i) => i.key));
    if (fresh.length > 0 || [...this.seen].some((k) => !current.has(k))) {
      this.seen = current;
      writeFileAtomic(this.file, JSON.stringify([...current]));
    }
  }
}

function num(t: Task): string {
  return String(Number(t.id.slice(1)));
}

function lastQuestion(board: Board, t: Task): string {
  const line = board.readLog(t.id).split('\n').filter((l) => l.includes('] 질문:')).pop() ?? '';
  return line.replace(/^- \S+ \[[^\]]+\] 질문: (→ \S+: )?/, '').slice(0, 200) || t.title;
}
