/**
 * Helpers for building fork-mode session snapshots for child subagent runs.
 *
 * Fork snapshots are taken while the parent subagent tool is still executing.
 * At that point the current assistant message usually contains one or more
 * toolCall blocks whose toolResult messages do not exist yet. If those orphaned
 * tool calls are replayed in the child context, providers synthesize an error
 * result like "No result provided", which can confuse the child into thinking
 * its own delegation already failed.
 *
 * Keep the raw parent session untouched, but omit incomplete tool-call turns from
 * the serialized child snapshot.
 */

export interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getMessage(entry: unknown): Record<string, unknown> | null {
  if (!isObject(entry) || entry.type !== "message") return null;
  return isObject(entry.message) ? entry.message : null;
}

function getAssistantToolCallIds(entry: unknown): string[] {
  const message = getMessage(entry);
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }

  const ids: string[] = [];
  for (const part of message.content) {
    if (
      isObject(part) &&
      part.type === "toolCall" &&
      typeof part.id === "string" &&
      part.id.length > 0
    ) {
      ids.push(part.id);
    }
  }
  return ids;
}

function getToolResultId(entry: unknown): string | null {
  const message = getMessage(entry);
  if (!message || message.role !== "toolResult") return null;
  return typeof message.toolCallId === "string" && message.toolCallId.length > 0
    ? message.toolCallId
    : null;
}

/**
 * Return a display/session-copy branch with incomplete tool-call turns removed.
 *
 * A tool-call turn is incomplete when an assistant message contains a toolCall id
 * that has no matching toolResult message anywhere in the branch. In that case,
 * omit the assistant message and any sibling toolResult messages for that same
 * assistant message. This preserves completed historical tool turns while
 * avoiding provider-injected "No result provided" placeholders for the active
 * parent tool call.
 */
export function sanitizeForkSnapshotBranch(branch: unknown[]): unknown[] {
  const completedToolCallIds = new Set<string>();
  for (const entry of branch) {
    const toolResultId = getToolResultId(entry);
    if (toolResultId) completedToolCallIds.add(toolResultId);
  }

  const omittedToolCallIds = new Set<string>();
  const sanitized: unknown[] = [];

  for (const entry of branch) {
    const assistantToolCallIds = getAssistantToolCallIds(entry);
    if (assistantToolCallIds.length > 0) {
      const hasUnresolvedToolCall = assistantToolCallIds.some(
        (id) => !completedToolCallIds.has(id),
      );
      if (hasUnresolvedToolCall) {
        for (const id of assistantToolCallIds) omittedToolCallIds.add(id);
        continue;
      }
    }

    const toolResultId = getToolResultId(entry);
    if (toolResultId && omittedToolCallIds.has(toolResultId)) continue;

    sanitized.push(entry);
  }

  return sanitized;
}

export function buildForkSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  const branchEntries = sessionManager.getBranch();
  if (!Array.isArray(branchEntries)) return null;

  const lines = [JSON.stringify(header)];
  for (const entry of sanitizeForkSnapshotBranch(branchEntries)) {
    lines.push(JSON.stringify(entry));
  }
  return `${lines.join("\n")}\n`;
}
