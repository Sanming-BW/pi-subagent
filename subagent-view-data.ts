import { getResultSummaryText } from "./runner-events.js";
import {
  type DelegationMode,
  type DisplayItem,
  type SingleResult,
  type SubagentDetails,
  aggregateUsage,
  getDisplayItems,
  getFinalOutput,
  isResultError,
  isResultSuccess,
} from "./types.js";

export type SubagentNodeKind = "root" | "call" | "agent";
export type SubagentNodeStatus = "running" | "success" | "error" | "mixed";

export interface SubagentTreeNode {
  id: string;
  kind: SubagentNodeKind;
  label: string;
  status: SubagentNodeStatus;
  displayState?: "blocked";
  callIndex?: number;
  resultIndex?: number;
  mode?: "single" | "parallel";
  delegationMode?: DelegationMode;
  projectAgentsDir?: string | null;
  result?: SingleResult;
  resultText?: string;
  isError?: boolean;
  children: SubagentTreeNode[];
}

export interface SubagentCallRecord {
  details: SubagentDetails;
  resultText?: string;
  isError: boolean;
}

export interface FlatSubagentNode {
  node: SubagentTreeNode;
  depth: number;
  parent: SubagentTreeNode | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDelegationMode(value: unknown): value is DelegationMode {
  return value === "spawn" || value === "fork" || value === "continue";
}

function isSingleResult(value: unknown): value is SingleResult {
  if (!isObject(value)) return false;
  if (
    typeof value.agent !== "string" ||
    typeof value.task !== "string" ||
    typeof value.exitCode !== "number" ||
    !Array.isArray(value.messages)
  ) {
    return false;
  }
  if (value.nestedDetails !== undefined) {
    if (!Array.isArray(value.nestedDetails)) return false;
    if (!value.nestedDetails.every((item) => parseSubagentDetails(item) !== null)) return false;
  }
  return true;
}

export function parseSubagentDetails(value: unknown): SubagentDetails | null {
  if (!isObject(value)) return null;
  if (value.mode !== "single" && value.mode !== "parallel") return null;
  if (!isDelegationMode(value.delegationMode)) return null;
  if (!Array.isArray(value.results)) return null;
  const results = value.results.filter(isSingleResult);
  if (results.length !== value.results.length) return null;
  return {
    mode: value.mode,
    delegationMode: value.delegationMode,
    projectAgentsDir: typeof value.projectAgentsDir === "string" ? value.projectAgentsDir : null,
    results,
  };
}

export function extractSubagentCallRecords(branch: unknown[]): SubagentCallRecord[] {
  const records: SubagentCallRecord[] = [];
  for (const entry of branch) {
    if (!isObject(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isObject(message)) continue;
    if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
    const details = parseSubagentDetails(message.details);
    if (!details) continue;

    let resultText: string | undefined;
    if (Array.isArray(message.content)) {
      const texts: string[] = [];
      for (const item of message.content) {
        if (isObject(item) && item.type === "text" && typeof item.text === "string") {
          texts.push(item.text);
        }
      }
      if (texts.length > 0) resultText = texts.join("\n");
    }

    records.push({
      details,
      resultText,
      isError: message.isError === true,
    });
  }
  return records;
}

export function extractSubagentDetailsFromBranch(branch: unknown[]): SubagentDetails[] {
  return extractSubagentCallRecords(branch).map((record) => record.details);
}

export function computeResultStatus(result: SingleResult): SubagentNodeStatus {
  if (result.exitCode === -1) return "running";
  if (isResultError(result)) return "error";
  if (isResultSuccess(result)) return "success";
  return "error";
}

export function computeAggregateStatus(nodes: Array<SubagentTreeNode | SingleResult>): SubagentNodeStatus {
  const statuses = nodes.map((item) => "children" in item ? item.status : computeResultStatus(item));
  if (statuses.length === 0) return "success";
  if (statuses.includes("running")) return "running";
  const unique = new Set(statuses);
  if (unique.size === 1) return statuses[0] ?? "success";
  return "mixed";
}

export function statusIcon(status: SubagentNodeStatus): string {
  switch (status) {
    case "running": return "⏳";
    case "success": return "✓";
    case "error": return "✗";
    case "mixed": return "◐";
  }
}

export function isBlockedParallelCall(details: SubagentDetails): boolean {
  return details.mode === "parallel" && details.results.length === 0;
}

export function buildSubagentTreeFromRecords(records: SubagentCallRecord[], idPrefix = ""): SubagentTreeNode {
  const root: SubagentTreeNode = {
    id: idPrefix ? `${idPrefix}/root` : "root",
    kind: "root",
    label: "Session",
    status: "success",
    children: [],
  };

  records.forEach((record, callZeroIndex) => {
    const { details, resultText, isError } = record;
    const callIndex = callZeroIndex + 1;
    if (details.mode === "single") {
      const result = details.results[0];
      if (!result) return;
      const agentId = idPrefix
        ? `${idPrefix}/call-${callIndex}-agent-0`
        : `call-${callIndex}-agent-0`;
      root.children.push(
        buildAgentNode(result, agentId, `#${callIndex} ${result.agent}`, callIndex, 0, details),
      );
      return;
    }

    const callId = idPrefix ? `${idPrefix}/call-${callIndex}` : `call-${callIndex}`;
    const children: SubagentTreeNode[] = details.results.map((result, resultIndex) =>
      buildAgentNode(
        result,
        `${callId}-agent-${resultIndex}`,
        result.agent,
        callIndex,
        resultIndex,
        details,
      ),
    );
    const blocked = isBlockedParallelCall(details);
    const status: SubagentNodeStatus = children.length === 0 ? "error" : computeAggregateStatus(children);
    root.children.push({
      id: callId,
      kind: "call",
      label: `#${callIndex} ${blocked ? "blocked" : "parallel"}`,
      status,
      displayState: blocked ? "blocked" : undefined,
      callIndex,
      mode: details.mode,
      delegationMode: details.delegationMode,
      projectAgentsDir: details.projectAgentsDir,
      resultText,
      isError,
      children,
    });
  });

  root.status = computeAggregateStatus(root.children);
  return root;
}

export function buildSubagentTreeFromDetails(records: SubagentDetails[], idPrefix = ""): SubagentTreeNode {
  return buildSubagentTreeFromRecords(
    records.map((details) => ({ details, isError: false })),
    idPrefix,
  );
}

function buildAgentNode(
  result: SingleResult,
  id: string,
  label: string,
  callIndex: number,
  resultIndex: number,
  details: SubagentDetails,
): SubagentTreeNode {
  const node: SubagentTreeNode = {
    id,
    kind: "agent",
    label,
    status: computeResultStatus(result),
    callIndex,
    resultIndex,
    mode: details.mode,
    delegationMode: details.delegationMode,
    projectAgentsDir: details.projectAgentsDir,
    result,
    children: [],
  };
  if (result.nestedDetails && result.nestedDetails.length > 0) {
    const nested = buildSubagentTreeFromDetails(result.nestedDetails, id);
    node.children = nested.children;
  }
  return node;
}

export function buildSubagentTree(branch: unknown[]): SubagentTreeNode {
  return buildSubagentTreeFromRecords(extractSubagentCallRecords(branch));
}

export function flattenSubagentTree(root: SubagentTreeNode): FlatSubagentNode[] {
  const rows: FlatSubagentNode[] = [];
  function visit(node: SubagentTreeNode, depth: number, parent: SubagentTreeNode | null): void {
    rows.push({ node, depth, parent });
    for (const child of node.children) visit(child, depth + 1, node);
  }
  visit(root, 0, null);
  return rows;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 1000000) return `${Math.round(count / 100) / 10}k`;
  return `${Math.round(count / 100000) / 10}M`;
}

function formatUsage(result: SingleResult): string {
  const u = result.usage;
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turn${u.turns === 1 ? "" : "s"}`);
  if (u.input) parts.push(`input ${formatTokens(u.input)}`);
  if (u.output) parts.push(`output ${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`cache read ${formatTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`cache write ${formatTokens(u.cacheWrite)}`);
  if (u.contextTokens) parts.push(`ctx ${formatTokens(u.contextTokens)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  return parts.join(", ");
}

function toolCallLines(items: DisplayItem[]): string[] {
  return items
    .filter((item): item is Extract<DisplayItem, { type: "toolCall" }> => item.type === "toolCall")
    .map((item) => `→ ${item.name} ${JSON.stringify(item.args)}`);
}

function pushSection(lines: string[], title: string, body: string | string[] | undefined): void {
  const content = Array.isArray(body) ? body : body ? body.split(/\r?\n/) : [];
  if (content.length === 0) return;
  if (lines.length > 0) lines.push("");
  lines.push(title, "─".repeat(title.length));
  lines.push(...content);
}

export function buildAgentDetailLines(node: SubagentTreeNode): string[] {
  const r = node.result;
  if (!r) return [`${node.label} ${statusIcon(node.status)}`, "", "Select an agent node and press Enter to view details."];

  const lines: string[] = [];
  lines.push(`${r.agent} ${statusIcon(computeResultStatus(r))} [${node.delegationMode ?? "spawn"}]`);
  lines.push(`Source: ${r.agentSource ?? "unknown"}`);
  lines.push(`Status: ${computeResultStatus(r)}`);
  if (r.stopReason) lines.push(`Stop reason: ${r.stopReason}`);
  if (r.model) lines.push(`Model: ${r.model}`);
  if (r.childSessionId) lines.push(`Child session: ${r.childSessionId}`);
  if (r.childSessionFile) lines.push(`Session file: ${r.childSessionFile}`);
  if (r.childLeafId) lines.push(`Leaf: ${r.childLeafId}`);
  if (r.lineEvent) {
    lines.push(`Line: ${r.lineEvent.lineId} (${r.lineEvent.event}, ${r.lineEvent.originMode})`);
  }
  if (r.warning || r.lineEvent?.warning) lines.push(`Warning: ${r.warning ?? r.lineEvent?.warning}`);
  if (r.errorMessage) lines.push(`Error: ${r.errorMessage}`);

  pushSection(lines, "Task", r.task);
  const items = getDisplayItems(r.messages);
  pushSection(lines, "Tool calls", toolCallLines(items));
  const finalOutput = getFinalOutput(r.messages).trim();
  pushSection(lines, "Output", finalOutput || getResultSummaryText(r));
  if (isResultError(r) && r.stderr?.trim()) pushSection(lines, "Stderr", r.stderr.trim());
  const usage = formatUsage(r);
  if (usage) pushSection(lines, "Usage", usage);
  return lines;
}

export function buildCallDetailLines(node: SubagentTreeNode): string[] {
  const isBlocked = node.displayState === "blocked";
  const lines = [
    isBlocked
      ? `blocked [${node.delegationMode ?? "spawn"}]`
      : `${node.label} ${statusIcon(node.status)} [${node.delegationMode ?? "spawn"}]`,
    "",
  ];

  if (node.children.length === 0) {
    lines.push("This call produced no agents.");
    pushSection(lines, node.isError ? "Error" : "Reason", node.resultText);
    pushSection(lines, "Metadata", [
      `Mode: ${node.mode ?? "unknown"}`,
      `Delegation: ${node.delegationMode ?? "spawn"}`,
      `isError: ${node.isError === true ? "true" : "false"}`,
      `projectAgentsDir: ${node.projectAgentsDir ?? "null"}`,
    ]);
    return lines;
  }

  for (const child of node.children) {
    const r = child.result;
    if (!r) continue;
    lines.push(`${statusIcon(child.status)} ${r.agent}: ${getResultSummaryText(r).split(/\r?\n/)[0] ?? ""}`);
  }
  const results = node.children.map((child) => child.result).filter((r): r is SingleResult => Boolean(r));
  const usage = aggregateUsage(results);
  if (usage.turns || usage.input || usage.output || usage.cost) {
    lines.push("", `Total: ${usage.turns} turns, input ${formatTokens(usage.input)}, output ${formatTokens(usage.output)}, $${usage.cost.toFixed(4)}`);
  }
  return lines;
}
