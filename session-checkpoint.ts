import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

interface SessionHeader {
  type: "session";
  id: string;
  [key: string]: unknown;
}

interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  [key: string]: unknown;
}

function readJsonl(filePath: string): unknown[] {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isHeader(value: unknown): value is SessionHeader {
  return Boolean(value) && typeof value === "object" && (value as { type?: unknown }).type === "session" && typeof (value as { id?: unknown }).id === "string";
}

function isEntry(value: unknown): value is SessionEntry {
  return Boolean(value) && typeof value === "object" && (value as { type?: unknown }).type !== "session" && typeof (value as { id?: unknown }).id === "string";
}

export function getSessionLeafId(sessionFile: string): string | undefined {
  const entries = readJsonl(sessionFile).filter(isEntry);
  if (entries.length === 0) return undefined;
  const parentIds = new Set(entries.map((entry) => entry.parentId).filter((id): id is string => typeof id === "string"));
  return entries.findLast((entry) => !parentIds.has(entry.id))?.id ?? entries.at(-1)?.id;
}

export function buildCheckpointSnapshot(sourceSessionFile: string, leafId: string, newSessionId = randomUUID()): { sessionId: string; jsonl: string } {
  const records = readJsonl(sourceSessionFile);
  const header = records.find(isHeader);
  if (!header) throw new Error(`Invalid session file without header: ${sourceSessionFile}`);

  const entries = records.filter(isEntry);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const leaf = byId.get(leafId);
  if (!leaf) throw new Error(`Checkpoint leaf "${leafId}" not found in ${sourceSessionFile}`);

  const branch: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    branch.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  branch.reverse();

  const snapshotHeader: SessionHeader = {
    ...header,
    id: newSessionId,
    parentSession: sourceSessionFile,
    timestamp: new Date().toISOString(),
  };
  const lines = [snapshotHeader, ...branch].map((record) => JSON.stringify(record));
  return { sessionId: newSessionId, jsonl: `${lines.join("\n")}\n` };
}

export function materializeCheckpointSnapshot(sourceSessionFile: string, leafId: string): { sessionId: string; sessionFile: string } {
  const sessionId = randomUUID();
  const snapshot = buildCheckpointSnapshot(sourceSessionFile, leafId, sessionId);
  const sessionFile = path.join(path.dirname(sourceSessionFile), `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, snapshot.jsonl, { encoding: "utf8", mode: 0o600 });
  return { sessionId, sessionFile };
}

export function needsCopyOnWrite(sourceSessionFile: string, checkpointLeafId: string | undefined): boolean {
  if (!checkpointLeafId) return false;
  try {
    return getSessionLeafId(sourceSessionFile) !== checkpointLeafId;
  } catch {
    return false;
  }
}
