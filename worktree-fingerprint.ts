import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { WorktreeFingerprint } from "./types.js";

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trimEnd();
}

export function getWorktreeFingerprint(cwd: string): WorktreeFingerprint {
  const gitHead = gitOutput(cwd, ["rev-parse", "HEAD"]);
  const status = gitOutput(cwd, ["status", "--porcelain"]);
  const diff = gitOutput(cwd, ["diff"]);

  return {
    cwd,
    gitHead,
    statusHash: status === undefined ? undefined : hashText(status),
    diffHash: diff === undefined ? undefined : hashText(diff),
  };
}

export function hasWorktreeDrift(previous: WorktreeFingerprint | undefined, current: WorktreeFingerprint): boolean {
  if (!previous) return false;
  return (
    previous.cwd !== current.cwd ||
    previous.gitHead !== current.gitHead ||
    previous.statusHash !== current.statusHash ||
    previous.diffHash !== current.diffHash
  );
}

export const WORKTREE_DRIFT_TASK_PREFIX = `Note: The worktree appears to have changed since this subagent line was last used.
Do not rely on prior memory for file contents. Re-read relevant files before editing.

`;
