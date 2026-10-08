import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './board.ts';
import type { Paths } from './paths.ts';

/**
 * Images the owner attaches to goals, answers and messages. They live in board/attachments
 * because every employee run (work, review, chat) may already read the board; the message
 * text carries the absolute path, and the employee opens it with the Read tool.
 */

export const MAX_UPLOAD = 10 * 1024 * 1024;

/** Types the console shows inline. SVG is only shown from outputs, never accepted as an upload. */
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export function attachmentsDir(paths: Paths): string {
  return path.join(paths.board, 'attachments');
}

/** Detects the format from the bytes, not from what the browser claims. */
function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Saves one uploaded image and returns its absolute path. */
export function saveAttachment(paths: Paths, buf: Buffer): string {
  if (!buf.length) throw new BoardError('빈 파일입니다.');
  if (buf.length > MAX_UPLOAD) throw new BoardError(`이미지는 ${MAX_UPLOAD / 1024 / 1024}MB 까지 올릴 수 있습니다.`);
  const ext = sniff(buf);
  if (!ext) throw new BoardError('PNG, JPG, GIF, WEBP 이미지만 올릴 수 있습니다.');
  const dir = attachmentsDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `${stamp}-${randomBytes(4).toString('hex')}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

/** The content type of a viewable image, or null. */
export function imageType(file: string): string | null {
  return IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()] ?? null;
}

/** An attachment path from a message, checked to be an image inside board/attachments. */
export function resolveAttachment(paths: Paths, file: string): { full: string; type: string } {
  const dir = path.resolve(attachmentsDir(paths));
  const full = path.resolve(dir, file);
  const type = imageType(full);
  if (!full.startsWith(dir + path.sep) || !type || type === IMAGE_TYPES.svg) throw new BoardError('첨부 이미지가 아닙니다.');
  if (!fs.existsSync(full)) throw new BoardError('파일이 없습니다.');
  return { full, type };
}
