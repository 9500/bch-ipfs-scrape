/**
 * Write a file atomically: the content goes to a temporary file next to the
 * target, which is then renamed over it. A crash mid-write leaves the old
 * file intact instead of a truncated one.
 */

import { writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { dirname } from 'path';

export function writeFileAtomic(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, path);
  } catch (error) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best effort
      }
    }
    throw error;
  }
}
