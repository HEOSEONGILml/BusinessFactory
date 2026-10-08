import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { Paths } from './paths.ts';

/**
 * Optional password login for the web console, for reaching it from outside the server
 * (e.g. over Tailscale). Off until `bf web-password` stores a hash in company/.web-password.
 */

const COOKIE = 'bf_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
export const MIN_PASSWORD = 8;

export function passwordFile(paths: Paths): string {
  return path.join(paths.company, '.web-password');
}

export function setPassword(paths: Paths, password: string): void {
  if (password.length < MIN_PASSWORD) throw new Error(`암호는 ${MIN_PASSWORD}자 이상이어야 합니다.`);
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  fs.writeFileSync(passwordFile(paths), `scrypt$${salt.toString('hex')}$${hash.toString('hex')}\n`, { mode: 0o600 });
}

export function clearPassword(paths: Paths): boolean {
  if (!fs.existsSync(passwordFile(paths))) return false;
  fs.rmSync(passwordFile(paths));
  return true;
}

function readHash(paths: Paths): { salt: Buffer; hash: Buffer } | null {
  try {
    const [kind, salt, hash] = fs.readFileSync(passwordFile(paths), 'utf8').trim().split('$');
    if (kind !== 'scrypt' || !salt || !hash) return null;
    return { salt: Buffer.from(salt, 'hex'), hash: Buffer.from(hash, 'hex') };
  } catch {
    return null;
  }
}

export interface WebAuth {
  /** True when a password is set, so every request needs a session. */
  enabled(): boolean;
  isLoggedIn(req: http.IncomingMessage): boolean;
  /** Checks the password; on success returns the Set-Cookie value. Throws when locked out. */
  login(password: string, secure: boolean): string | null;
  logout(req: http.IncomingMessage): string;
}

/** Sessions live in memory: an engine restart means logging in again. */
export function createWebAuth(paths: Paths): WebAuth {
  const sessions = new Map<string, number>();
  let failures: number[] = [];

  const sessionId = (req: http.IncomingMessage): string | null => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === COOKIE && v) return v;
    }
    return null;
  };

  return {
    enabled: () => readHash(paths) !== null,
    isLoggedIn(req) {
      const id = sessionId(req);
      const expires = id ? sessions.get(id) : undefined;
      if (!id || !expires) return false;
      if (expires < Date.now()) {
        sessions.delete(id);
        return false;
      }
      return true;
    },
    login(password, secure) {
      const now = Date.now();
      failures = failures.filter((t) => now - t < FAILURE_WINDOW_MS);
      if (failures.length >= MAX_FAILURES) throw new Error('로그인 실패가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.');
      const stored = readHash(paths);
      if (!stored) return null;
      const given = scryptSync(password, stored.salt, stored.hash.length);
      if (!timingSafeEqual(given, stored.hash)) {
        failures.push(now);
        return null;
      }
      const id = randomBytes(32).toString('hex');
      sessions.set(id, now + SESSION_DAYS * 86_400_000);
      return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
    },
    logout(req) {
      const id = sessionId(req);
      if (id) sessions.delete(id);
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
    },
  };
}

export const LOGIN_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BusinessFactory 로그인</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f4f4f2;color:#222}
  form{background:#fff;padding:28px 24px;border-radius:12px;box-shadow:0 2px 12px #0001;width:min(320px,calc(100vw - 32px));box-sizing:border-box}
  h1{font-size:18px;margin:0 0 16px}
  input,button{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border-radius:8px}
  input{border:1px solid #ccc;margin-bottom:12px}
  button{border:0;background:#222;color:#fff;cursor:pointer}
  p{color:#c33;font-size:14px;margin:0 0 12px;min-height:1em}
  @media (prefers-color-scheme: dark){body{background:#1b1b1b;color:#eee}form{background:#262626}input{background:#1b1b1b;color:#eee;border-color:#444}button{background:#eee;color:#222}}
</style></head><body>
<form method="post" action="/login">
  <h1>BusinessFactory</h1>
  <p>%%ERROR%%</p>
  <input type="password" name="password" placeholder="암호" autocomplete="current-password" autofocus required>
  <button>로그인</button>
</form>
</body></html>`;
