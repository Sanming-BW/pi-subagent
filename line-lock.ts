import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const LOCK_ROOT = path.join(os.tmpdir(), "pi-subagent-line-locks");
const DEFAULT_STALE_MS = 10 * 60 * 1000;

function safeKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function lockPath(key: string): string {
  return path.join(LOCK_ROOT, safeKey(key));
}

function isStale(dir: string, staleMs: number): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, "lock.json"), "utf8");
    const parsed = JSON.parse(raw);
    const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : 0;
    return Date.now() - createdAt >= staleMs;
  } catch {
    return true;
  }
}

export interface LineLock {
  release: () => void;
}

export function acquireLineLock(key: string, staleMs = DEFAULT_STALE_MS): LineLock {
  fs.mkdirSync(LOCK_ROOT, { recursive: true });
  const dir = lockPath(key);

  try {
    fs.mkdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    if (isStale(dir, staleMs)) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
    } else {
      throw new Error(`Subagent line is already running: ${key}`);
    }
  }

  fs.writeFileSync(
    path.join(dir, "lock.json"),
    JSON.stringify({ key, pid: process.pid, createdAt: Date.now() }, null, 2),
    "utf8",
  );

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function withLineLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const lock = acquireLineLock(key);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
