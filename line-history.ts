import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { SubagentLineEvent } from "./types.js";

export const MAX_VISIBLE_LINES_PER_AGENT = 3;

export interface VisibleLine {
  agentName: string;
  lineId: string;
  event: SubagentLineEvent;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isLineEvent(value: unknown): value is SubagentLineEvent {
  return (
    isObject(value) &&
    (value.event === "open" || value.event === "continue") &&
    typeof value.agentName === "string" &&
    typeof value.lineId === "string" &&
    typeof value.childSessionId === "string"
  );
}

function extractLineEventsFromDetails(details: unknown): SubagentLineEvent[] {
  if (!isObject(details)) return [];
  const results = details.results;
  if (!Array.isArray(results)) return [];

  const events: SubagentLineEvent[] = [];
  for (const result of results) {
    if (!isObject(result)) continue;
    const lineEvent = result.lineEvent;
    if (isLineEvent(lineEvent)) events.push(lineEvent);
  }
  return events;
}

function extractLineEventsFromEntry(entry: unknown): SubagentLineEvent[] {
  if (!isObject(entry) || entry.type !== "message") return [];
  const message = entry.message;
  if (!isObject(message) || message.role !== "toolResult") return [];
  if (message.toolName !== "subagent") return [];
  return extractLineEventsFromDetails(message.details);
}

/** Extract subagent line events from the current parent branch. */
export function getBranchLineEvents(branchEntries: unknown[]): SubagentLineEvent[] {
  const events: SubagentLineEvent[] = [];
  for (const entry of branchEntries) {
    events.push(...extractLineEventsFromEntry(entry));
  }
  return events;
}

/** Return current-branch visible lines for an agent, newest first, capped at 3. */
export function getVisibleLinesForAgent(
  branchEntries: unknown[],
  agentName: string,
): VisibleLine[] {
  const latestByLine = new Map<string, SubagentLineEvent>();

  for (const event of getBranchLineEvents(branchEntries)) {
    if (event.agentName !== agentName) continue;
    // Re-set to keep insertion order aligned with the latest visible checkpoint.
    latestByLine.delete(event.lineId);
    latestByLine.set(event.lineId, event);
  }

  return Array.from(latestByLine.entries())
    .reverse()
    .slice(0, MAX_VISIBLE_LINES_PER_AGENT)
    .map(([lineId, event]) => ({ agentName, lineId, event }));
}

export function findVisibleLine(
  branchEntries: SessionEntry[] | unknown[],
  agentName: string,
  lineId: string,
): VisibleLine | null {
  return getVisibleLinesForAgent(branchEntries, agentName).find((line) => line.lineId === lineId) ?? null;
}

export function formatAvailableLines(branchEntries: unknown[], agentName: string): string {
  const lines = getVisibleLinesForAgent(branchEntries, agentName);
  if (lines.length === 0) return "none";
  return lines
    .map((line) => {
      const child = line.event.childLeafId
        ? `${line.event.childSessionId}@${line.event.childLeafId}`
        : line.event.childSessionId;
      return `- ${line.lineId} (${child})`;
    })
    .join("\n");
}
