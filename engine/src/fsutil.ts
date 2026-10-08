import fs from 'node:fs';

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function isRetryable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/**
 * Write via temp file + rename so readers never see a half-written file.
 * Windows can briefly refuse the rename while another process (or antivirus)
 * has the target open, so retry a few times.
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!isRetryable(err) || attempt >= 20) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(50);
    }
  }
}

export interface LockOptions {
  timeoutMs?: number;
  /** A lock older than this is assumed to belong to a crashed process. */
  staleMs?: number;
}

/** Cross-process mutex using mkdir, which is atomic on every platform. */
export function withLock<T>(lockDir: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const staleMs = opts.staleMs ?? 60_000;
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock vanished between mkdir and stat; just retry.
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`잠금 대기 시간 초과: ${lockDir}`);
      }
      sleepSync(20 + Math.random() * 40);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
