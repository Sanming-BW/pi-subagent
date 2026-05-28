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

export type LegacyNodeKind = "root" | "agent";
export type ActivityNodeKind = "session" | "active-agent-turn" | "subagent";
export type SubagentTreeNodeKind = LegacyNodeKind | ActivityNodeKind;
export type SubagentNodeStatus =
  | "pending"
  | "running"
  | "streaming"
  | "success"
  | "error"
  | "cancelled"
  | "mixed";

export interface SubagentTreeNode {
  id: string;
  kind: SubagentTreeNodeKind;
  label: string;
  status: SubagentNodeStatus;
  sessionId?: string | null;
  parentId?: string | null;
  orderKey?: number;
  turnIndex?: number;
  turnIndices?: number[];
  previousTurnId?: string | null;
  isCurrent?: boolean;
  recovered?: boolean;
  activeAgentName?: string;
  userMessagePreview?: string;
  streamingText?: string;
  finalText?: string;
  delegationMode?: DelegationMode;
  projectAgentsDir?: string | null;
  toolCallId?: string;
  toolName?: string;
  toolArgsSignature?: string;
  result?: SingleResult;
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

export interface SubagentTreeSummary {
  total: number;
  turns: number;
  subagents: number;
  pending: number;
  running: number;
  streaming: number;
  success: number;
  error: number;
  cancelled: number;
  mixed: number;
}

export interface ActivityStoreTurnInput {
  turnIndex?: number;
  timestamp?: number;
  userMessage?: unknown;
  userMessagePreview?: string;
  streamingText?: string;
  finalText?: string;
  recovered?: boolean;
  activeAgentName?: string;
  isCurrent?: boolean;
  forceNew?: boolean;
  status?: SubagentNodeStatus;
}

export interface ActivityStoreSubagentInput {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  timestamp?: number;
  status?: SubagentNodeStatus;
  streamingText?: string;
  finalText?: string;
  result?: unknown;
  isError?: boolean;
  parentTurnId?: string;
  delegationMode?: DelegationMode;
  projectAgentsDir?: string | null;
}

export interface ActivityStoreSubscriber {
  (): void;
}

export interface ActivityStore {
  reset(sessionId?: string | null): void;
  reconcileBranch(branch: unknown[], header?: unknown): void;
  noteUserInput(text: unknown, timestamp?: number): void;
  beginActiveAgentTurn(input?: ActivityStoreTurnInput): SubagentTreeNode;
  updateActiveAgentTurn(input?: ActivityStoreTurnInput & { id?: string; turnId?: string }): SubagentTreeNode | undefined;
  finishActiveAgentModelTurn(input?: ActivityStoreTurnInput & { id?: string; turnId?: string }): SubagentTreeNode | undefined;
  endActiveAgentTurn(input?: ActivityStoreTurnInput & { id?: string; turnId?: string; status?: SubagentNodeStatus }): SubagentTreeNode | undefined;
  startSubagentTool(input?: ActivityStoreSubagentInput): SubagentTreeNode | undefined;
  updateSubagentTool(input?: ActivityStoreSubagentInput & { id?: string }): SubagentTreeNode | undefined;
  endSubagentTool(input?: ActivityStoreSubagentInput & { id?: string; status?: SubagentNodeStatus }): SubagentTreeNode | undefined;
  getTree(): SubagentTreeNode;
  getSignature(): string;
  subscribe(listener: ActivityStoreSubscriber): () => void;
  getCurrentTurn(): SubagentTreeNode | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  if (value.mode !== "single") return null;
  if (!isDelegationMode(value.delegationMode)) return null;
  if (!Array.isArray(value.results)) return null;
  if (value.results.length > 1) return null;
  const results = value.results.filter(isSingleResult);
  if (results.length !== value.results.length) return null;
  return {
    mode: "single",
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

function computeResultStatus(result: SingleResult): SubagentNodeStatus {
  if (result.exitCode === -1) return "running";
  if (isResultError(result)) {
    if (result.stopReason === "aborted") return "cancelled";
    return "error";
  }
  if (isResultSuccess(result)) return "success";
  return "error";
}

function computeStatusFromNode(node: Pick<SubagentTreeNode, "status">): SubagentNodeStatus {
  return node.status;
}

function statusRank(status: SubagentNodeStatus): number {
  switch (status) {
    case "pending": return 0;
    case "running": return 1;
    case "streaming": return 2;
    case "success": return 3;
    case "mixed": return 4;
    case "error": return 5;
    case "cancelled": return 6;
  }
}

function isTerminalStatus(status: SubagentNodeStatus): boolean {
  return status === "success" || status === "error" || status === "cancelled" || status === "mixed";
}

function isActiveStatus(status: SubagentNodeStatus): boolean {
  return status === "pending" || status === "running" || status === "streaming";
}

function mergeStatus(current: SubagentNodeStatus, next: SubagentNodeStatus): SubagentNodeStatus {
  if (current === next) return current;
  if (current === "cancelled") return "cancelled";
  if (next === "cancelled") return "cancelled";
  if (current === "error") return current;
  if (next === "error") return current === "success" ? "mixed" : "error";
  if (current === "mixed") return "mixed";
  if (next === "mixed") return current === "success" ? "mixed" : next;
  if (isTerminalStatus(current) && !isTerminalStatus(next)) return current;
  if (current === "pending") return next;
  if (current === "running" && next === "streaming") return "streaming";
  if (current === "streaming" && next === "running") return "streaming";
  if (current === "running" && next === "pending") return "running";
  if (current === "streaming" && next === "pending") return "streaming";
  return statusRank(next) >= statusRank(current) ? next : current;
}

export function statusIcon(status: SubagentNodeStatus): string {
  switch (status) {
    case "pending": return "◌";
    case "running": return "⏳";
    case "streaming": return "⋯";
    case "success": return "✓";
    case "error": return "✗";
    case "cancelled": return "⊘";
    case "mixed": return "◐";
  }
}

export function statusLabel(status: SubagentNodeStatus): string {
  return status;
}

export function statusBadge(status: SubagentNodeStatus): string {
  return `${statusIcon(status)} ${statusLabel(status)}`;
}

function createSessionNode(sessionId?: string | null): SubagentTreeNode {
  return {
    id: sessionId ? `session:${sessionId}` : "session",
    kind: "session",
    label: sessionId ? `Session ${sessionId}` : "Session",
    status: "success",
    sessionId: sessionId ?? null,
    parentId: null,
    orderKey: 0,
    children: [],
  };
}

function createLegacyRoot(idPrefix = ""): SubagentTreeNode {
  return {
    id: idPrefix ? `${idPrefix}/root` : "root",
    kind: "root",
    label: "Session",
    status: "success",
    children: [],
  };
}

function createLegacyAgentNode(
  result: SingleResult,
  id: string,
  label: string,
  details: SubagentDetails,
): SubagentTreeNode {
  const node: SubagentTreeNode = {
    id,
    kind: "agent",
    label,
    status: computeResultStatus(result),
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

function createTurnLabel(turn: Pick<SubagentTreeNode, "orderKey" | "recovered" | "activeAgentName">): string {
  const index = turn.orderKey ?? 0;
  const prefix = turn.recovered ? "Recovered turn" : "Turn";
  const agent = typeof turn.activeAgentName === "string" && turn.activeAgentName.trim() ? ` · ${turn.activeAgentName.trim()}` : "";
  return `${prefix} #${index}${agent}`;
}

function refreshTurnLabel(turn: Pick<SubagentTreeNode, "orderKey" | "recovered" | "activeAgentName" | "userMessagePreview">): string {
  return `${createTurnLabel(turn)}${turn.userMessagePreview ? ` · ${turn.userMessagePreview}` : ""}`;
}

function normalizeActiveAgentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeConcreteActiveAgentName(value: unknown): string | undefined {
  const name = normalizeActiveAgentName(value);
  if (!name || name === "Pi") return undefined;
  return name;
}

function assignActiveAgentName(turn: Pick<SubagentTreeNode, "activeAgentName"> & { activeAgentName?: string }, nextValue: unknown): boolean {
  const nextName = normalizeConcreteActiveAgentName(nextValue);
  if (!nextName) return false;

  const currentRaw = normalizeActiveAgentName(turn.activeAgentName);
  const currentName = normalizeConcreteActiveAgentName(turn.activeAgentName);
  if (currentName === nextName) return false;
  if (!currentName || currentRaw === "Pi") {
    turn.activeAgentName = nextName;
    return true;
  }
  return false;
}

function recordTurnIndex(turn: Pick<SubagentTreeNode, "turnIndex" | "turnIndices"> & { turnIndices?: number[] }, turnIndex?: number): boolean {
  if (!isNumber(turnIndex)) return false;
  if (!turn.turnIndices) turn.turnIndices = [];
  if (!turn.turnIndices.includes(turnIndex)) turn.turnIndices.push(turnIndex);
  if (turn.turnIndex === undefined) turn.turnIndex = turnIndex;
  return true;
}

function getTurnDisplayIndex(turn: Pick<SubagentTreeNode, "orderKey">): number {
  return turn.orderKey ?? 0;
}

function createTurnNode(sessionId: string | null, input: ActivityStoreTurnInput = {}, previousTurnId?: string | null, orderKey = 0): SubagentTreeNode {
  const turnIndex = input.turnIndex ?? orderKey;
  const activeAgentName = normalizeConcreteActiveAgentName(input.activeAgentName);
  const baseLabel = createTurnLabel({ orderKey, recovered: input.recovered, activeAgentName });
  const node: SubagentTreeNode = {
    id: `turn-${orderKey}`,
    kind: "active-agent-turn",
    label: input.userMessagePreview ? `${baseLabel} · ${input.userMessagePreview}` : baseLabel,
    status: input.status ?? "pending",
    sessionId,
    parentId: sessionId ? `session:${sessionId}` : null,
    orderKey,
    turnIndex,
    turnIndices: isNumber(turnIndex) ? [turnIndex] : [],
    previousTurnId,
    isCurrent: input.isCurrent ?? true,
    recovered: input.recovered ?? false,
    activeAgentName,
    userMessagePreview: input.userMessagePreview,
    streamingText: input.streamingText,
    finalText: input.finalText,
    children: [],
  };
  return node;
}

function createSubagentLabel(result: Partial<SingleResult> | undefined, toolName?: string, toolCallId?: string): string {
  const agent = typeof result?.agent === "string" && result.agent.trim() ? result.agent.trim() : undefined;
  if (agent) return agent;
  if (toolCallId) return `${toolName ?? "subagent"} ${toolCallId}`;
  return toolName ?? "subagent";
}

function createSubagentNode(
  sessionId: string | null,
  parentTurnId: string,
  input: ActivityStoreSubagentInput = {},
  orderKey = 0,
): SubagentTreeNode {
  const toolCallId = typeof input.toolCallId === "string" && input.toolCallId.trim() ? input.toolCallId.trim() : undefined;
  const result = parseSubagentResult(input.result);
  const toolArgsSignature = input.args ? stableStringify(input.args) : undefined;
  const label = createSubagentLabel(result, input.toolName, toolCallId);
  return {
    id: toolCallId ? `subagent:${toolCallId}` : `subagent:${parentTurnId}:${orderKey}`,
    kind: "subagent",
    label,
    status: input.status ?? (result ? computeResultStatus(result) : "running"),
    sessionId,
    parentId: parentTurnId,
    orderKey,
    toolCallId,
    toolName: input.toolName ?? "subagent",
    toolArgsSignature,
    delegationMode: input.delegationMode ?? result?.lineEvent?.originMode ?? undefined,
    projectAgentsDir: input.projectAgentsDir ?? result?.nestedDetails?.[0]?.projectAgentsDir ?? null,
    result,
    children: [],
  };
}

function serializeMessage(message: unknown): unknown {
  if (!isObject(message)) return message;
  return {
    role: message.role,
    timestamp: message.timestamp,
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    content: message.content,
  };
}

function serializeResult(result: SingleResult): unknown {
  return {
    agent: result.agent,
    agentSource: result.agentSource,
    task: result.task,
    exitCode: result.exitCode,
    stderr: result.stderr,
    usage: result.usage,
    model: result.model,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    sawAgentEnd: result.sawAgentEnd,
    childSessionId: result.childSessionId,
    childSessionFile: result.childSessionFile,
    childLeafId: result.childLeafId,
    lineEvent: result.lineEvent,
    warning: result.warning,
    messages: result.messages.map(serializeMessage),
  };
}

function serializeNode(node: SubagentTreeNode): unknown {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    status: node.status,
    sessionId: node.sessionId,
    parentId: node.parentId,
    orderKey: node.orderKey,
    turnIndex: node.turnIndex,
    turnIndices: node.turnIndices,
    previousTurnId: node.previousTurnId,
    isCurrent: node.isCurrent,
    recovered: node.recovered,
    activeAgentName: node.activeAgentName,
    userMessagePreview: node.userMessagePreview,
    streamingText: node.streamingText,
    finalText: node.finalText,
    delegationMode: node.delegationMode,
    projectAgentsDir: node.projectAgentsDir,
    toolCallId: node.toolCallId,
    toolName: node.toolName,
    toolArgsSignature: node.toolArgsSignature,
    result: node.result ? serializeResult(node.result) : undefined,
    children: node.children.map(serializeNode),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

function parseToolCallBlocks(message: unknown): Array<{ id?: string; name: string; arguments: Record<string, unknown> }> {
  if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: Array<{ id?: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const part of message.content) {
    if (!isObject(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
    const args = isObject(part.arguments) ? part.arguments : {};
    calls.push({
      id: typeof part.id === "string" && part.id.trim() ? part.id.trim() : undefined,
      name: part.name,
      arguments: args,
    });
  }
  return calls;
}

function extractAssistantText(message: unknown): string {
  if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const part of message.content) {
    if (isObject(part) && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}

function extractUserText(message: unknown): string {
  if (!isObject(message) || message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (isObject(part) && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}

function extractToolResultDetails(message: unknown): SubagentDetails | null {
  if (!isObject(message) || message.role !== "toolResult" || message.toolName !== "subagent") return null;
  return parseSubagentDetails(message.details);
}

interface TurnMeta {
  turnIndex: number;
  activeAgentName?: string;
  phase?: string;
  version?: number;
}

function extractTurnMetaMap(branch: unknown[]): Map<number, TurnMeta> {
  const metaMap = new Map<number, TurnMeta>();
  for (const entry of branch) {
    if (!isObject(entry) || entry.type !== "custom") continue;
    if (entry.customType !== "pi-subagent-turn-meta") continue;
    const data = entry.data;
    if (!isObject(data)) continue;
    const turnIndex = typeof data.turnIndex === "number" && Number.isFinite(data.turnIndex) ? data.turnIndex : undefined;
    if (turnIndex === undefined) continue;
    const activeAgentName = normalizeConcreteActiveAgentName(data.activeAgentName);
    const phase = typeof data.phase === "string" && data.phase.trim() ? data.phase.trim() : undefined;
    const version = typeof data.version === "number" && Number.isFinite(data.version) ? data.version : undefined;
    const existing = metaMap.get(turnIndex);
    if (!existing || activeAgentName || phase || version !== undefined) {
      metaMap.set(turnIndex, {
        turnIndex,
        activeAgentName: activeAgentName ?? existing?.activeAgentName,
        phase: phase ?? existing?.phase,
        version: version ?? existing?.version,
      });
    }
  }
  return metaMap;
}

function applyTurnMeta(turn: SubagentTreeNode, turnMetaMap: Map<number, TurnMeta>): void {
  const meta = turnMetaMap.get(turn.turnIndex ?? turn.orderKey ?? 0);
  if (!meta) return;
  recordTurnIndex(turn, meta.turnIndex);
  if (assignActiveAgentName(turn, meta.activeAgentName)) {
    // label refreshed below
  }
  turn.label = refreshTurnLabel(turn);
}

function applyTurnMetaEntry(turn: SubagentTreeNode, meta: TurnMeta): void {
  recordTurnIndex(turn, meta.turnIndex);
  if (assignActiveAgentName(turn, meta.activeAgentName)) {
    // label refreshed below
  }
  turn.label = refreshTurnLabel(turn);
}

function insertTurnInOrder(root: SubagentTreeNode, turn: SubagentTreeNode): void {
  const index = turn.orderKey ?? root.children.length + 1;
  const insertAt = root.children.findIndex((child) => (child.orderKey ?? 0) > index);
  const previousTurnId = insertAt > 0 ? root.children[insertAt - 1]?.id ?? null : null;
  turn.previousTurnId = previousTurnId;
  turn.parentId = root.id;
  if (insertAt < 0) root.children.push(turn);
  else root.children.splice(insertAt, 0, turn);
}

function recoverMissingTurns(root: SubagentTreeNode, turnMetaMap: Map<number, TurnMeta>, sessionId: string | null): void {
  if (turnMetaMap.size === 0) return;
  const existingTurnIndices = new Set<number>();
  for (const turn of root.children) {
    if (turn.turnIndex !== undefined) existingTurnIndices.add(turn.turnIndex);
    if (turn.turnIndices) {
      for (const index of turn.turnIndices) existingTurnIndices.add(index);
    }
  }
  const missing = Array.from(turnMetaMap.values()).filter((meta) => !existingTurnIndices.has(meta.turnIndex)).sort((a, b) => a.turnIndex - b.turnIndex);
  for (const meta of missing) {
    const orderKey = root.children.length + 1;
    const turn = createTurnNode(sessionId, {
      turnIndex: meta.turnIndex,
      activeAgentName: meta.activeAgentName,
      recovered: true,
      isCurrent: false,
      status: "success",
    }, root.children.length > 0 ? root.children[root.children.length - 1].id : null, orderKey);
    turn.parentId = root.id;
    turn.label = refreshTurnLabel(turn);
    insertTurnInOrder(root, turn);
  }
}

const MAX_SUBAGENT_RESULT_UNWRAP_DEPTH = 8;

function parseSubagentResult(value: unknown, depth = 0, seen = new Set<object>()): SingleResult | undefined {
  if (depth > MAX_SUBAGENT_RESULT_UNWRAP_DEPTH) return undefined;
  if (isSingleResult(value)) return value;
  if (!isObject(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const directDetails = parseSubagentDetails(value);
  if (directDetails?.results[0]) return directDetails.results[0];

  const candidates: unknown[] = [];
  if ("details" in value) candidates.push(value.details);
  if ("result" in value) candidates.push(value.result);
  if ("partialResult" in value) candidates.push(value.partialResult);
  if ("content" in value) {
    if (Array.isArray(value.content)) candidates.push(...value.content);
    else candidates.push(value.content);
  }
  if (Array.isArray(value.results)) candidates.push(value.results[0]);

  for (const candidate of candidates) {
    const parsed = parseSubagentResult(candidate, depth + 1, seen);
    if (parsed) return parsed;
  }

  return undefined;
}

function findSubagentNodeByToolCallId(node: SubagentTreeNode, toolCallId?: string): SubagentTreeNode | undefined {
  if (!toolCallId) return undefined;
  for (const child of node.children) {
    const childIdMatches = child.id === toolCallId || child.id.endsWith(`:${toolCallId}`) || child.id.endsWith(`/subagent-${toolCallId}`);
    const resultIdMatches = child.result?.toolCallId === toolCallId || child.result?.childLeafId === toolCallId || child.result?.lineEvent?.lineId === toolCallId;
    if (child.toolCallId === toolCallId || childIdMatches || resultIdMatches) return child;
    const nested = findSubagentNodeByToolCallId(child, toolCallId);
    if (nested) return nested;
  }
  return undefined;
}

function findChildById(node: SubagentTreeNode, id?: string): SubagentTreeNode | undefined {
  if (!id) return undefined;
  return node.children.find((child) => child.id === id);
}

function findSubagentNodeByInputSignature(
  turn: SubagentTreeNode,
  input: ActivityStoreSubagentInput,
  toolCallId?: string,
): SubagentTreeNode | undefined {
  if (toolCallId) return findSubagentNodeByToolCallId(turn, toolCallId);
  if (!input.toolName) return undefined;
  const toolArgsSignature = input.args ? stableStringify(input.args) : undefined;
  return turn.children.find((child) => {
    if (child.toolName !== input.toolName) return false;
    if (toolArgsSignature && child.toolArgsSignature === toolArgsSignature) return true;
    return child.status === (input.status ?? child.status) && (!child.toolCallId || child.toolCallId === toolCallId);
  });
}

function findDirectSubagentNodeBySemanticInput(parent: SubagentTreeNode, input: ActivityStoreSubagentInput): SubagentTreeNode | undefined {
  const toolArgsSignature = input.args ? stableStringify(input.args) : undefined;
  return parent.children.find((child) => {
    if (input.toolName && child.toolName !== input.toolName) return false;
    if (toolArgsSignature) return child.toolArgsSignature === toolArgsSignature && isActiveStatus(child.status);
    if (!input.toolCallId) return isActiveStatus(child.status);
    return false;
  });
}

function recomputeSessionStatus(root: SubagentTreeNode): void {
  const childStatuses = root.children.map(computeStatusFromNode);
  if (childStatuses.length === 0) {
    root.status = "success";
    return;
  }
  root.status = computeAggregateStatus(root.children);
}

function computeAggregateStatus(nodes: Array<SubagentTreeNode | SingleResult>): SubagentNodeStatus {
  const statuses = nodes.map((item) => ("children" in item ? item.status : computeResultStatus(item)));
  if (statuses.length === 0) return "success";
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.includes("error")) return statuses.includes("success") ? "mixed" : "error";
  if (statuses.includes("mixed")) return "mixed";
  if (statuses.includes("streaming")) return "streaming";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("pending")) return "pending";
  const unique = new Set(statuses);
  return unique.size === 1 ? statuses[0] ?? "success" : "mixed";
}

function settleDescendantStatuses(node: SubagentTreeNode, terminalStatus: SubagentNodeStatus): void {
  for (const child of node.children) {
    if (isActiveStatus(child.status)) {
      child.status = mergeStatus(child.status, terminalStatus);
    }
    if (child.children.length > 0) {
      settleDescendantStatuses(child, terminalStatus);
    }
  }
}

function settleSubtreeToTerminalStatus(node: SubagentTreeNode, terminalStatus: SubagentNodeStatus): void {
  node.status = mergeStatus(node.status, terminalStatus);
  settleDescendantStatuses(node, terminalStatus);
}

function isDescendantNode(root: SubagentTreeNode, maybeDescendant: SubagentTreeNode): boolean {
  if (root === maybeDescendant) return true;
  for (const child of root.children) {
    if (isDescendantNode(child, maybeDescendant)) return true;
  }
  return false;
}

function removeActiveStackEntriesForNode(stack: SubagentTreeNode[], node: SubagentTreeNode): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (isDescendantNode(node, stack[i]!)) {
      stack.splice(i, 1);
    }
  }
}

function constrainNodeToTerminalParent(parent: SubagentTreeNode, node: SubagentTreeNode): void {
  if (!isTerminalStatus(parent.status) || !isActiveStatus(node.status)) return;
  node.status = mergeStatus(node.status, parent.status);
}

function settleTurnChildren(turn: SubagentTreeNode): void {
  if (!isTerminalStatus(turn.status)) return;
  settleDescendantStatuses(turn, turn.status);
}

function updateTurnContent(node: SubagentTreeNode, message: unknown): void {
  const assistantText = extractAssistantText(message);
  if (assistantText) {
    node.streamingText = assistantText;
    node.finalText = assistantText;
  }
  const userText = extractUserText(message);
  if (userText) {
    node.userMessagePreview = userText;
    node.label = createTurnLabel(node) + ` · ${userText}`;
  }
}

function updateSubagentFromToolCall(
  node: SubagentTreeNode,
  toolCall: { id?: string; name: string; arguments: Record<string, unknown> },
): void {
  node.toolCallId = toolCall.id ?? node.toolCallId;
  node.toolName = toolCall.name;
  const args = toolCall.arguments;
  const agentName = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : undefined;
  if (agentName && (!node.label || node.label === node.toolName || node.label.startsWith(`${node.toolName ?? "subagent"} `) || node.label === node.toolCallId)) node.label = agentName;
  const mode = typeof args.mode === "string" ? args.mode : undefined;
  if (mode === "spawn" || mode === "fork" || mode === "continue") node.delegationMode = mode;
}

function mergeSubagentResult(node: SubagentTreeNode, details: SubagentDetails, isError = false, resultText?: string): void {
  const result = details.results[0];
  if (result) {
    node.result = result;
    if (!node.label || node.label === node.toolName || node.label.startsWith(`${node.toolName ?? "subagent"} `)) {
      node.label = result.agent || node.label;
    }
    node.delegationMode = details.delegationMode;
    node.projectAgentsDir = details.projectAgentsDir;
    node.status = mergeStatus(node.status, computeResultStatus(result));
    if (result.nestedDetails && result.nestedDetails.length > 0) {
      const seenToolCallIds = new Set<string>();
      for (const [index, nested] of result.nestedDetails.entries()) {
        const nestedResult = nested.results[0];
        if (!nestedResult) continue;
        const nestedToolCallId = nestedResult.toolCallId ?? nestedResult.childLeafId ?? nestedResult.lineEvent?.lineId ?? `${node.toolCallId ?? node.id}:${index}`;
        if (seenToolCallIds.has(nestedToolCallId)) continue;
        seenToolCallIds.add(nestedToolCallId);
        const nestedNode = upsertSubagentNode(node, {
          toolCallId: nestedToolCallId,
          toolName: "subagent",
          result: nestedResult,
          delegationMode: nested.delegationMode,
          projectAgentsDir: nested.projectAgentsDir,
          status: computeResultStatus(nestedResult),
        }, node.children.length + index + 1);
        mergeSubagentResult(nestedNode, nested, false, getResultSummaryText(nestedResult));
      }
    }
  }
  if (isError) node.status = mergeStatus(node.status, "error");
  if (resultText) node.finalText = resultText;
}

function normalizeSubagentNodeFromInput(node: SubagentTreeNode, input: ActivityStoreSubagentInput, toolCallId?: string): void {
  if (input.toolName) node.toolName = input.toolName;
  if (toolCallId) node.toolCallId = toolCallId;
  node.toolArgsSignature = input.args ? stableStringify(input.args) : node.toolArgsSignature;
  if (input.delegationMode) node.delegationMode = input.delegationMode;
  if (input.projectAgentsDir !== undefined) node.projectAgentsDir = input.projectAgentsDir;
  if (input.args && isObject(input.args) && input.toolName) {
    updateSubagentFromToolCall(node, {
      id: toolCallId,
      name: input.toolName,
      arguments: input.args,
    });
  }
  const parsedResult = parseSubagentResult(input.result);
  if (parsedResult) {
    node.result = parsedResult;
    node.label = parsedResult.agent || node.label;
    node.status = mergeStatus(node.status, computeResultStatus(parsedResult));
    if (parsedResult.nestedDetails && parsedResult.nestedDetails.length > 0) {
      for (const [index, nested] of parsedResult.nestedDetails.entries()) {
        const nestedResult = nested.results[0];
        if (!nestedResult) continue;
        const nestedToolCallId = nestedResult.toolCallId ?? nestedResult.childLeafId ?? nestedResult.lineEvent?.lineId ?? `${node.toolCallId ?? node.id}:${index}`;
        const nestedNode = upsertSubagentNode(node, {
          toolCallId: nestedToolCallId,
          toolName: "subagent",
          result: nestedResult,
          delegationMode: nested.delegationMode,
          projectAgentsDir: nested.projectAgentsDir,
          status: computeResultStatus(nestedResult),
        }, node.children.length + index + 1);
        mergeSubagentResult(nestedNode, nested, false, getResultSummaryText(nestedResult));
      }
    }
  }
  if (typeof input.status === "string") node.status = mergeStatus(node.status, input.status);
  if (input.isError) node.status = mergeStatus(node.status, "error");
}

function upsertSubagentNode(
  turn: SubagentTreeNode,
  input: ActivityStoreSubagentInput,
  orderKey: number,
): SubagentTreeNode {
  const toolCallId = typeof input.toolCallId === "string" && input.toolCallId.trim() ? input.toolCallId.trim() : undefined;
  let node = findSubagentNodeByToolCallId(turn, toolCallId);
  if (!node) {
    node = findSubagentNodeByInputSignature(turn, input, toolCallId);
  }
  if (!node) {
    node = createSubagentNode(turn.sessionId ?? null, turn.id, input, orderKey);
    turn.children.push(node);
  }

  node.parentId = turn.id;
  node.orderKey = node.orderKey ?? orderKey;
  node.sessionId = turn.sessionId ?? null;
  normalizeSubagentNodeFromInput(node, input, toolCallId);
  constrainNodeToTerminalParent(turn, node);
  return node;
}

function setCurrentTurn(root: SubagentTreeNode, turn: SubagentTreeNode | undefined): void {
  for (const child of root.children) {
    child.isCurrent = false;
  }
  if (turn) turn.isCurrent = true;
}

function closeTurn(turn: SubagentTreeNode | undefined): void {
  if (!turn) return;
  if (turn.status === "pending") {
    turn.status = turn.children.some((child) => child.status === "running" || child.status === "streaming") ? "running" : "success";
  } else if ((turn.status === "running" || turn.status === "streaming") && turn.children.every((child) => isTerminalStatus(child.status))) {
    turn.status = computeAggregateStatus(turn.children);
  } else if ((turn.status === "running" || turn.status === "streaming") && turn.children.length === 0) {
    turn.status = "success";
  }
  if (isTerminalStatus(turn.status)) {
    settleTurnChildren(turn);
  }
  turn.isCurrent = false;
}

class ActivityTreeStoreImpl implements ActivityStore {
  private root: SubagentTreeNode = createSessionNode(null);
  private currentSessionId: string | null = null;
  private currentTurn: SubagentTreeNode | undefined;
  private activeSubagentStack: SubagentTreeNode[] = [];
  private turnSequence = 0;
  private pendingUserText: string | undefined;
  private subscribers = new Set<ActivityStoreSubscriber>();
  private signature = getSubagentTreeSignature(this.root);

  private emitChange(force = false): void {
    const nextSignature = getSubagentTreeSignature(this.root);
    if (!force && nextSignature === this.signature) return;
    this.signature = nextSignature;
    for (const subscriber of this.subscribers) subscriber();
  }

  private ensureRoot(sessionId?: string | null): void {
    const normalized = sessionId ?? null;
    if (this.currentSessionId === normalized) return;
    this.currentSessionId = normalized;
    this.root = createSessionNode(normalized);
    this.currentTurn = undefined;
    this.activeSubagentStack = [];
    this.turnSequence = 0;
    this.pendingUserText = undefined;
    this.signature = getSubagentTreeSignature(this.root);
  }

  reset(sessionId?: string | null): void {
    this.currentSessionId = sessionId ?? null;
    this.root = createSessionNode(this.currentSessionId);
    this.currentTurn = undefined;
    this.activeSubagentStack = [];
    this.turnSequence = 0;
    this.pendingUserText = undefined;
    this.emitChange(true);
  }

  reconcileBranch(branch: unknown[], header?: unknown): void {
    const sessionId = isObject(header) && isString(header.id) ? header.id : this.currentSessionId;
    this.ensureRoot(sessionId ?? null);

    if (this.currentTurn) {
      return;
    }

    this.root.children = [];
    this.currentTurn = undefined;
    this.activeSubagentStack = [];
    this.pendingUserText = undefined;

    let turnMetaMap = extractTurnMetaMap(branch);
    const getTurn = () => this.currentTurn;
    for (const entry of branch) {
      if (isObject(entry) && entry.type === "custom" && entry.customType === "pi-subagent-turn-meta") {
        const data = isObject(entry.data) ? entry.data : undefined;
        const turnIndex = data && typeof data.turnIndex === "number" && Number.isFinite(data.turnIndex) ? data.turnIndex : undefined;
        if (turnIndex !== undefined && this.currentTurn) {
          applyTurnMetaEntry(this.currentTurn, {
            turnIndex,
            activeAgentName: normalizeConcreteActiveAgentName(data.activeAgentName),
            phase: typeof data.phase === "string" && data.phase.trim() ? data.phase.trim() : undefined,
            version: typeof data.version === "number" && Number.isFinite(data.version) ? data.version : undefined,
          });
          turnMetaMap.delete(turnIndex);
        }
        continue;
      }
      if (!isObject(entry) || entry.type !== "message") continue;
      const message = entry.message;
      if (!isObject(message)) continue;

      if (message.role === "user") {
        closeTurn(this.currentTurn);
        this.currentTurn = undefined;
        this.pendingUserText = extractUserText(message) || this.pendingUserText;
        this.beginActiveAgentTurn({
          forceNew: true,
          status: "pending",
          userMessage: message,
          userMessagePreview: this.pendingUserText,
          recovered: false,
          isCurrent: false,
        });
        updateTurnContent(getTurn()!, message);
        applyTurnMeta(getTurn()!, turnMetaMap);
        continue;
      }

      if (message.role === "assistant") {
        if (!this.currentTurn) {
          this.beginActiveAgentTurn({
            recovered: true,
            status: "running",
            isCurrent: false,
            userMessagePreview: this.pendingUserText,
          });
        }
        const turn = this.currentTurn!;
        applyTurnMeta(turn, turnMetaMap);
        turn.status = mergeStatus(turn.status, message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "error" : "running");
        updateTurnContent(turn, message);
        const calls = parseToolCallBlocks(message);
        for (const call of calls) {
          if (call.name !== "subagent") continue;
          upsertSubagentNode(turn, {
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments,
            status: "running",
          }, turn.children.length + 1);
        }
        continue;
      }

      if (message.role === "toolResult" && message.toolName === "subagent") {
        if (!this.currentTurn) {
          this.beginActiveAgentTurn({ recovered: true, status: "running", isCurrent: false });
        }
        const turn = this.currentTurn!;
        applyTurnMeta(turn, turnMetaMap);
        const details = extractToolResultDetails(message);
        const child = upsertSubagentNode(turn, {
          toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
          toolName: message.toolName,
          result: details ?? message.details,
          isError: message.isError === true,
          status: message.isError === true ? "error" : "success",
        }, turn.children.length + 1);
        if (details) mergeSubagentResult(child, details, message.isError === true, Array.isArray(message.content) ? message.content.map((part: unknown) => (isObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n") : undefined);
        else if (message.isError === true) child.status = mergeStatus(child.status, "error");
      }
    }

    closeTurn(this.currentTurn);
    this.currentTurn = undefined;
    recoverMissingTurns(this.root, turnMetaMap, this.currentSessionId);
    this.turnSequence = this.root.children.reduce((max, child) => Math.max(max, child.orderKey ?? 0), 0);
    recomputeSessionStatus(this.root);
    this.emitChange();
  }

  noteUserInput(text: unknown, _timestamp?: number): void {
    if (!isString(text)) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.pendingUserText = trimmed;
  }

  beginActiveAgentTurn(input: ActivityStoreTurnInput = {}): SubagentTreeNode {
    if (!input.forceNew && this.currentTurn && !isTerminalStatus(this.currentTurn.status)) {
      recordTurnIndex(this.currentTurn, input.turnIndex);
      if (input.userMessagePreview !== undefined) this.currentTurn.userMessagePreview = input.userMessagePreview;
      if (input.streamingText !== undefined) this.currentTurn.streamingText = input.streamingText;
      if (input.finalText !== undefined) this.currentTurn.finalText = input.finalText;
      if (input.status) this.currentTurn.status = mergeStatus(this.currentTurn.status, input.status);
      if (input.recovered !== undefined) this.currentTurn.recovered = input.recovered;
      const hadActiveAgentName = normalizeActiveAgentName(this.currentTurn.activeAgentName);
      const activeAgentChanged = assignActiveAgentName(this.currentTurn, input.activeAgentName);
      if (input.userMessagePreview !== undefined || activeAgentChanged || (input.activeAgentName !== undefined && !hadActiveAgentName)) {
        this.currentTurn.label = refreshTurnLabel(this.currentTurn);
      }
      return this.currentTurn;
    }

    const previousTurnId = this.root.children.length > 0 ? this.root.children[this.root.children.length - 1].id : null;
    const orderKey = ++this.turnSequence;
    const turn = createTurnNode(this.currentSessionId, {
      ...input,
      userMessagePreview: input.userMessagePreview ?? this.pendingUserText,
      isCurrent: input.isCurrent ?? true,
    }, previousTurnId, orderKey);
    if (input.turnIndex === undefined) turn.turnIndex = orderKey;
    recordTurnIndex(turn, input.turnIndex);
    turn.label = input.userMessagePreview ?? this.pendingUserText ? `${createTurnLabel(turn)} · ${input.userMessagePreview ?? this.pendingUserText}` : createTurnLabel(turn);
    turn.parentId = this.root.id;
    this.root.children.push(turn);
    this.currentTurn = turn;
    this.pendingUserText = undefined;
    setCurrentTurn(this.root, turn);
    recomputeSessionStatus(this.root);
    this.emitChange();
    return turn;
  }

  updateActiveAgentTurn(input: ActivityStoreTurnInput & { id?: string; turnId?: string } = {}): SubagentTreeNode | undefined {
    const turn = this.findTurn(input.id ?? input.turnId, input.turnIndex);
    if (!turn) return undefined;
    recordTurnIndex(turn, input.turnIndex);
    if (input.userMessagePreview !== undefined) turn.userMessagePreview = input.userMessagePreview;
    const hadActiveAgentName = normalizeActiveAgentName(turn.activeAgentName);
    const activeAgentChanged = assignActiveAgentName(turn, input.activeAgentName);
    if (input.streamingText !== undefined) turn.streamingText = input.streamingText;
    if (input.finalText !== undefined) turn.finalText = input.finalText;
    if (input.status) turn.status = mergeStatus(turn.status, input.status);
    if (input.recovered !== undefined) turn.recovered = input.recovered;
    if (input.isCurrent !== undefined) turn.isCurrent = input.isCurrent;
    if (input.userMessagePreview !== undefined || activeAgentChanged || (input.activeAgentName !== undefined && !hadActiveAgentName)) {
      turn.label = refreshTurnLabel(turn);
    }
    recomputeSessionStatus(this.root);
    this.emitChange();
    return turn;
  }

  finishActiveAgentModelTurn(input: ActivityStoreTurnInput & { id?: string; turnId?: string } = {}): SubagentTreeNode | undefined {
    const turn = this.findTurn(input.id ?? input.turnId, input.turnIndex) ?? this.currentTurn;
    if (!turn) return undefined;
    recordTurnIndex(turn, input.turnIndex);
    if (input.userMessagePreview !== undefined) turn.userMessagePreview = input.userMessagePreview;
    const hadActiveAgentName = normalizeActiveAgentName(turn.activeAgentName);
    const activeAgentChanged = assignActiveAgentName(turn, input.activeAgentName);
    if (input.streamingText !== undefined) turn.streamingText = input.streamingText;
    if (input.finalText !== undefined) turn.finalText = input.finalText;
    if (input.userMessagePreview !== undefined || activeAgentChanged || (input.activeAgentName !== undefined && !hadActiveAgentName)) {
      turn.label = refreshTurnLabel(turn);
    }
    this.activeSubagentStack = [];
    this.settleOrphanedRunningNodes();
    recomputeSessionStatus(this.root);
    this.emitChange();
    return turn;
  }

  endActiveAgentTurn(input: ActivityStoreTurnInput & { id?: string; turnId?: string; status?: SubagentNodeStatus } = {}): SubagentTreeNode | undefined {
    const turn = this.findTurn(input.id ?? input.turnId, input.turnIndex) ?? this.currentTurn;
    if (!turn) return undefined;
    const nextStatus = input.status ?? (turn.status === "cancelled" ? "cancelled" : turn.status === "error" ? "error" : "success");
    turn.status = mergeStatus(turn.status, nextStatus);
    turn.isCurrent = false;
    recordTurnIndex(turn, input.turnIndex);
    if (input.userMessagePreview !== undefined) turn.userMessagePreview = input.userMessagePreview;
    const hadActiveAgentName = normalizeActiveAgentName(turn.activeAgentName);
    const activeAgentChanged = assignActiveAgentName(turn, input.activeAgentName);
    if (input.streamingText !== undefined) turn.streamingText = input.streamingText;
    if (input.finalText !== undefined) turn.finalText = input.finalText;
    if (input.userMessagePreview !== undefined || activeAgentChanged || (input.activeAgentName !== undefined && !hadActiveAgentName)) {
      turn.label = refreshTurnLabel(turn);
    }
    if (isTerminalStatus(turn.status)) {
      settleTurnChildren(turn);
    }
    this.settleOrphanedRunningNodes();
    this.activeSubagentStack = [];
    this.currentTurn = undefined;
    recomputeSessionStatus(this.root);
    this.emitChange();
    return turn;
  }

  startSubagentTool(input: ActivityStoreSubagentInput = {}): SubagentTreeNode | undefined {
    const activeParent = this.activeSubagentStack.length > 0
      ? this.activeSubagentStack[this.activeSubagentStack.length - 1]
      : undefined;
    const turn = this.ensureCurrentTurn(input.parentTurnId);
    if (!turn) return undefined;

    const rootMatch = input.toolCallId ? this.findSubagent(input.toolCallId) : findDirectSubagentNodeBySemanticInput(turn, input);
    const nestedMatch = !rootMatch && activeParent && activeParent !== turn
      ? findDirectSubagentNodeBySemanticInput(activeParent, input)
      : undefined;
    const existing = rootMatch ?? nestedMatch;
    if (existing) {
      const parentNode = this.findNodeById(existing.parentId ?? "") ?? this.findParentTurn(existing.parentId);
      if (input.status) existing.status = mergeStatus(existing.status, input.status);
      if (input.args && isObject(input.args) && input.toolName) {
        updateSubagentFromToolCall(existing, {
          id: input.toolCallId,
          name: input.toolName,
          arguments: input.args,
        });
      }
      if (parentNode) {
        constrainNodeToTerminalParent(parentNode, existing);
        if (parentNode.kind === "active-agent-turn" && !isTerminalStatus(parentNode.status)) {
          parentNode.status = mergeStatus(parentNode.status, existing.status === "streaming" ? "streaming" : "running");
        }
        if (isTerminalStatus(parentNode.status)) {
          settleTurnChildren(parentNode);
        }
      }
      removeActiveStackEntriesForNode(this.activeSubagentStack, existing);
      this.activeSubagentStack.push(existing);
      this.emitChange();
      return existing;
    }

    const parent = activeParent ?? turn;
    const child = upsertSubagentNode(parent, {
      ...input,
      status: input.status ?? "running",
    }, parent.children.length + 1);
    if (input.toolCallId) {
      const duplicateIndex = this.activeSubagentStack.findIndex((node) => node.toolCallId === input.toolCallId);
      if (duplicateIndex >= 0) this.activeSubagentStack.splice(duplicateIndex, 1);
    }
    if (parent.kind === "active-agent-turn" && !isTerminalStatus(parent.status)) {
      parent.status = mergeStatus(parent.status, child.status === "streaming" ? "streaming" : "running");
    }
    if (isTerminalStatus(parent.status)) {
      settleTurnChildren(parent);
    }
    constrainNodeToTerminalParent(parent, child);
    removeActiveStackEntriesForNode(this.activeSubagentStack, child);
    this.activeSubagentStack.push(child);
    recomputeSessionStatus(this.root);
    this.emitChange();
    return child;
  }

  updateSubagentTool(input: ActivityStoreSubagentInput & { id?: string } = {}): SubagentTreeNode | undefined {
    const scopeTurn = input.parentTurnId ? this.findTurn(input.parentTurnId) : this.currentTurn;
    const activeParent = this.activeSubagentStack.length > 0
      ? this.activeSubagentStack[this.activeSubagentStack.length - 1]
      : undefined;
    const rootMatch = this.findSubagent(input.id ?? input.toolCallId)
      ?? (!input.id && !input.toolCallId && scopeTurn ? findDirectSubagentNodeBySemanticInput(scopeTurn, input) : undefined);
    let child = rootMatch
      ?? (!input.id && !input.toolCallId && activeParent && activeParent !== scopeTurn ? findDirectSubagentNodeBySemanticInput(activeParent, input) : undefined);
    if (!child) return input.toolCallId ? this.startSubagentTool(input) : undefined;
    const parentNode = this.findNodeById(child.parentId ?? "") ?? this.findParentTurn(child.parentId);
    if (input.toolName) child.toolName = input.toolName;
    if (input.status) child.status = mergeStatus(child.status, input.status);
    if (input.args && isObject(input.args) && input.toolName) {
      updateSubagentFromToolCall(child, {
        id: input.toolCallId,
        name: input.toolName,
        arguments: input.args,
      });
    }
    const parsedResult = parseSubagentResult(input.result);
    if (parsedResult) mergeSubagentResult(child, { mode: "single", delegationMode: input.delegationMode ?? child.delegationMode ?? "spawn", projectAgentsDir: input.projectAgentsDir ?? null, results: [parsedResult] }, input.isError === true);
    if (input.isError) child.status = mergeStatus(child.status, "error");
    if (parentNode) {
      constrainNodeToTerminalParent(parentNode, child);
      if (parentNode.kind === "active-agent-turn" && !isTerminalStatus(parentNode.status)) {
        parentNode.status = mergeStatus(parentNode.status, child.status === "streaming" ? "streaming" : "running");
        if (isTerminalStatus(parentNode.status)) {
          settleTurnChildren(parentNode);
        }
      } else if (isTerminalStatus(parentNode.status)) {
        settleTurnChildren(parentNode);
      }
    }
    recomputeSessionStatus(this.root);
    this.emitChange();
    return child;
  }

  endSubagentTool(input: ActivityStoreSubagentInput & { id?: string; status?: SubagentNodeStatus } = {}): SubagentTreeNode | undefined {
    const scopeTurn = input.parentTurnId ? this.findTurn(input.parentTurnId) : this.currentTurn;
    const activeParent = this.activeSubagentStack.length > 0
      ? this.activeSubagentStack[this.activeSubagentStack.length - 1]
      : undefined;
    const rootMatch = this.findSubagent(input.id ?? input.toolCallId)
      ?? (!input.id && !input.toolCallId && scopeTurn ? findDirectSubagentNodeBySemanticInput(scopeTurn, input) : undefined);
    const child = rootMatch
      ?? (!input.id && !input.toolCallId && activeParent && activeParent !== scopeTurn ? findDirectSubagentNodeBySemanticInput(activeParent, input) : undefined)
      ?? (input.toolCallId ? this.startSubagentTool(input) : undefined);
    if (!child) return undefined;
    const parentNode = this.findNodeById(child.parentId ?? "") ?? this.findParentTurn(child.parentId);
    const nextStatus = input.status ?? (input.isError ? "error" : child.status === "cancelled" ? "cancelled" : child.status === "error" ? "error" : "success");
    child.status = mergeStatus(child.status, nextStatus);
    const parsedResult = parseSubagentResult(input.result);
    if (parsedResult) mergeSubagentResult(child, { mode: "single", delegationMode: input.delegationMode ?? child.delegationMode ?? "spawn", projectAgentsDir: input.projectAgentsDir ?? null, results: [parsedResult] }, input.isError === true);
    if (input.isError) child.status = mergeStatus(child.status, "error");

    removeActiveStackEntriesForNode(this.activeSubagentStack, child);

    if (parentNode) {
      constrainNodeToTerminalParent(parentNode, child);
      if (parentNode.kind === "active-agent-turn") {
        if (isTerminalStatus(parentNode.status)) {
          settleTurnChildren(parentNode);
        } else {
          parentNode.status = mergeStatus(parentNode.status, child.status === "streaming" ? "streaming" : child.status === "running" ? "running" : parentNode.status);
          if (parentNode.status === "pending") parentNode.status = "running";
          if (isTerminalStatus(parentNode.status)) {
            settleTurnChildren(parentNode);
          }
        }
      } else if (isTerminalStatus(parentNode.status)) {
        settleTurnChildren(parentNode);
      }
    }
    if (isTerminalStatus(child.status) && child.children.length > 0) {
      settleDescendantStatuses(child, child.status);
    }
    recomputeSessionStatus(this.root);
    this.emitChange();
    return child;
  }

  getTree(): SubagentTreeNode {
    return this.root;
  }

  getSignature(): string {
    return this.signature;
  }

  subscribe(listener: ActivityStoreSubscriber): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  getCurrentTurn(): SubagentTreeNode | undefined {
    return this.currentTurn;
  }

  private ensureCurrentTurn(parentTurnId?: string): SubagentTreeNode {
    if (parentTurnId) {
      const turn = this.findTurn(parentTurnId);
      if (turn) return turn;
    }
    if (this.currentTurn) return this.currentTurn;
    return this.beginActiveAgentTurn({ recovered: true, status: "running" });
  }

  private findTurn(id?: string, turnIndex?: number): SubagentTreeNode | undefined {
    if (id) {
      const parsed = Number(id);
      return this.root.children.find((child) => {
        if (child.id === id) return true;
        if (String(child.turnIndex) === id) return true;
        return Array.isArray(child.turnIndices) && Number.isFinite(parsed) && child.turnIndices.includes(parsed);
      }) ?? this.currentTurn;
    }
    if (turnIndex !== undefined) {
      return this.root.children.find((child) => child.turnIndex === turnIndex || child.turnIndices?.includes(turnIndex)) ?? this.currentTurn;
    }
    return this.currentTurn;
  }

  private findNodeById(id: string): SubagentTreeNode | undefined {
    for (const turn of this.root.children) {
      const found = this.findNodeByIdRecursive(turn, id);
      if (found) return found;
    }
    return undefined;
  }

  private findNodeByIdRecursive(node: SubagentTreeNode, id: string): SubagentTreeNode | undefined {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = this.findNodeByIdRecursive(child, id);
      if (found) return found;
    }
    return undefined;
  }

  private findParentTurn(parentId?: string | null): SubagentTreeNode | undefined {
    if (!parentId) return undefined;
    return this.root.children.find((child) => child.id === parentId);
  }

  private findSubagent(id?: string): SubagentTreeNode | undefined {
    if (!id) return undefined;
    for (const turn of this.root.children) {
      const found = findSubagentNodeByToolCallId(turn, id);
      if (found) return found;
    }
    return undefined;
  }

  private settleOrphanedRunningNodes(): void {
    for (const turn of this.root.children) {
      if (isTerminalStatus(turn.status) || !turn.isCurrent) {
        settleTurnChildren(turn);
      }
    }
  }
}

export function createActivityStore(): ActivityStore {
  return new ActivityTreeStoreImpl();
}

export function buildSubagentTreeFromRecords(records: SubagentCallRecord[], idPrefix = ""): SubagentTreeNode {
  const root = createLegacyRoot(idPrefix);
  records.forEach((record, callZeroIndex) => {
    const result = record.details.results[0];
    if (!result) return;
    const callIndex = callZeroIndex + 1;
    const agentId = idPrefix ? `${idPrefix}/agent-${callIndex}` : `agent-${callIndex}`;
    root.children.push(createLegacyAgentNode(result, agentId, `#${callIndex} ${result.agent}`, record.details));
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

function buildSubagentNodeFromResult(
  result: SingleResult,
  id: string,
  label: string,
  details: SubagentDetails,
): SubagentTreeNode {
  const node: SubagentTreeNode = {
    id,
    kind: "subagent",
    label,
    status: computeResultStatus(result),
    delegationMode: details.delegationMode,
    projectAgentsDir: details.projectAgentsDir,
    result,
    children: [],
  };
  if (result.nestedDetails && result.nestedDetails.length > 0) {
    node.children = result.nestedDetails.flatMap((nested, index) => {
      const nestedResult = nested.results[0];
      if (!nestedResult) return [];
      return [buildSubagentNodeFromResult(nestedResult, `${id}/subagent-${index + 1}`, nestedResult.agent, nested)];
    });
  }
  return node;
}

function buildTurnFromAssistantRecord(message: unknown, sessionId?: string | null): SubagentTreeNode {
  const node = createTurnNode(sessionId ?? null, { status: "running", recovered: true }, undefined, 1);
  updateTurnContent(node, message);
  const calls = parseToolCallBlocks(message);
  for (const call of calls) {
    if (call.name !== "subagent") continue;
    const subagent = createSubagentNode(sessionId ?? null, node.id, {
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
      status: "running",
    }, node.children.length + 1);
    updateSubagentFromToolCall(subagent, call);
    node.children.push(subagent);
  }
  return node;
}

export function buildActivityTreeFromBranch(branch: unknown[], sessionId?: string | null): SubagentTreeNode {
  const root = createSessionNode(sessionId ?? null);
  const turnMetaMap = extractTurnMetaMap(branch);
  let currentTurn: SubagentTreeNode | undefined;
  let turnIndex = 0;
  const pendingMetaEntries: TurnMeta[] = [];

  const attachPendingMetaToCurrent = (): void => {
    if (!currentTurn || pendingMetaEntries.length === 0) return;
    for (const meta of pendingMetaEntries) {
      recordTurnIndex(currentTurn, meta.turnIndex);
      if (meta.activeAgentName) currentTurn.activeAgentName = meta.activeAgentName;
    }
    currentTurn.label = refreshTurnLabel(currentTurn);
    pendingMetaEntries.length = 0;
  };

  const materializePendingMetaAsTurns = (): void => {
    if (pendingMetaEntries.length === 0) return;
    for (const meta of pendingMetaEntries) {
      const orderKey = root.children.length + 1;
      const turn = createTurnNode(sessionId ?? null, {
        turnIndex: meta.turnIndex,
        activeAgentName: meta.activeAgentName,
        recovered: true,
        isCurrent: false,
        status: "success",
      }, root.children.length > 0 ? root.children[root.children.length - 1].id : null, orderKey);
      turn.parentId = root.id;
      turn.label = refreshTurnLabel(turn);
      insertTurnInOrder(root, turn);
    }
    pendingMetaEntries.length = 0;
  };

  for (const entry of branch) {
    if (isObject(entry) && entry.type === "custom" && entry.customType === "pi-subagent-turn-meta") {
      const data = isObject(entry.data) ? entry.data : undefined;
      const metaTurnIndex = data && typeof data.turnIndex === "number" && Number.isFinite(data.turnIndex) ? data.turnIndex : undefined;
      if (metaTurnIndex !== undefined) {
        pendingMetaEntries.push({
          turnIndex: metaTurnIndex,
          activeAgentName: normalizeConcreteActiveAgentName(data.activeAgentName),
          phase: typeof data.phase === "string" && data.phase.trim() ? data.phase.trim() : undefined,
          version: typeof data.version === "number" && Number.isFinite(data.version) ? data.version : undefined,
        });
      }
      continue;
    }

    if (!isObject(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isObject(message)) continue;

    if (message.role === "user") {
      if (currentTurn) {
        const isPlaceholderTurn = !currentTurn.userMessagePreview && currentTurn.children.length === 0 && !currentTurn.streamingText && !currentTurn.finalText;
        if (!isPlaceholderTurn) attachPendingMetaToCurrent();
        closeTurn(currentTurn);
        currentTurn = undefined;
      }

      turnIndex += 1;
      currentTurn = createTurnNode(sessionId ?? null, {
        turnIndex: pendingMetaEntries[0]?.turnIndex ?? turnIndex,
        userMessagePreview: extractUserText(message) || undefined,
        recovered: false,
        isCurrent: false,
        status: "pending",
      }, root.children.length > 0 ? root.children[root.children.length - 1].id : null, root.children.length + 1);
      currentTurn.parentId = root.id;
      root.children.push(currentTurn);
      attachPendingMetaToCurrent();
      currentTurn.label = currentTurn.userMessagePreview ? `${createTurnLabel(currentTurn)} · ${currentTurn.userMessagePreview}` : createTurnLabel(currentTurn);
      applyTurnMeta(currentTurn, turnMetaMap);
      continue;
    }

    if (!currentTurn) {
      turnIndex += 1;
      currentTurn = createTurnNode(sessionId ?? null, {
        turnIndex,
        recovered: true,
        status: "running",
        userMessagePreview: undefined,
        isCurrent: false,
      }, root.children.length > 0 ? root.children[root.children.length - 1].id : null, root.children.length + 1);
      currentTurn.parentId = root.id;
      applyTurnMeta(currentTurn, turnMetaMap);
      root.children.push(currentTurn);
      attachPendingMetaToCurrent();
    }

    if (message.role === "assistant") {
      currentTurn.status = mergeStatus(currentTurn.status, message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "error" : "streaming");
      updateTurnContent(currentTurn, message);
      const calls = parseToolCallBlocks(message);
      for (const call of calls) {
        if (call.name !== "subagent") continue;
        const child = upsertSubagentNode(currentTurn, {
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
          status: "running",
        }, currentTurn.children.length + 1);
        updateSubagentFromToolCall(child, call);
      }
      continue;
    }

    if (message.role === "toolResult" && message.toolName === "subagent") {
      const details = extractToolResultDetails(message);
      const child = upsertSubagentNode(currentTurn, {
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
        toolName: message.toolName,
        result: details ?? message.details,
        isError: message.isError === true,
        status: message.isError === true ? "error" : "success",
      }, currentTurn.children.length + 1);
      if (details) {
        mergeSubagentResult(child, details, message.isError === true, Array.isArray(message.content) ? message.content.map((part: unknown) => (isObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n") : undefined);
      }
      if (message.isError === true) {
        child.status = mergeStatus(child.status, "error");
      }
    }
  }

  attachPendingMetaToCurrent();
  if (currentTurn) closeTurn(currentTurn);
  materializePendingMetaAsTurns();
  recoverMissingTurns(root, turnMetaMap, sessionId ?? null);
  root.children.sort((a, b) => (a.orderKey ?? 0) - (b.orderKey ?? 0));
  root.status = computeAggregateStatus(root.children);
  return root;
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

function buildTurnDetailLines(node: SubagentTreeNode): string[] {
  const lines: string[] = [];
  lines.push(`${node.label} ${statusBadge(node.status)}`);
  if (node.sessionId) lines.push(`Session: ${node.sessionId}`);
  if (node.turnIndex !== undefined) lines.push(`Turn index: ${node.turnIndex}`);
  if (node.turnIndices && node.turnIndices.length > 1) lines.push(`Turn indices: ${node.turnIndices.join(", ")}`);
  if (node.previousTurnId) lines.push(`Previous turn: ${node.previousTurnId}`);
  lines.push(`Current: ${node.isCurrent ? "yes" : "no"}`);
  if (node.recovered) lines.push("Recovered: yes");
  if (node.activeAgentName) lines.push(`Active agent: ${node.activeAgentName}`);
  if (node.userMessagePreview) lines.push(`User message: ${node.userMessagePreview}`);
  if (node.streamingText) lines.push(`Streaming: ${node.streamingText}`);
  if (node.finalText) lines.push(`Final text: ${node.finalText}`);
  lines.push(`Subagents: ${node.children.length}`);
  const childStatusSummary = node.children.map((child) => `${child.label} ${statusBadge(child.status)}`);
  pushSection(lines, "Children", childStatusSummary);
  return lines;
}

export function buildAgentDetailLines(node: SubagentTreeNode): string[] {
  if (node.kind === "active-agent-turn" || node.kind === "session") {
    return buildTurnDetailLines(node);
  }

  const r = node.result;
  if (!r) {
    const lines: string[] = [];
    lines.push(`${node.label} ${statusBadge(node.status)}`);
    if (node.sessionId) lines.push(`Session: ${node.sessionId}`);
    if (node.parentId) lines.push(`Parent turn: ${node.parentId}`);
    if (node.toolCallId) lines.push(`Tool call: ${node.toolCallId}`);
    if (node.toolName) lines.push(`Tool: ${node.toolName}`);
    if (node.delegationMode) lines.push(`Mode: ${node.delegationMode}`);
    if (node.projectAgentsDir) lines.push(`Project agents: ${node.projectAgentsDir}`);
    lines.push(`Current: ${node.isCurrent ? "yes" : "no"}`);
    if (node.streamingText) lines.push(`Streaming: ${node.streamingText}`);
    if (node.finalText) lines.push(`Final text: ${node.finalText}`);
    if (node.children.length > 0) {
      lines.push(`Children: ${node.children.length}`);
      pushSection(lines, "Children", node.children.map((child) => `${child.label} ${statusBadge(child.status)}`));
    } else {
      lines.push("Awaiting tool result.");
    }
    return lines;
  }

  const status = computeResultStatus(r);
  const lines: string[] = [];
  lines.push(`${r.agent} ${statusBadge(status)} [${node.delegationMode ?? "spawn"}]`);
  lines.push(`Source: ${r.agentSource ?? "unknown"}`);
  lines.push(`Status: ${statusBadge(status)}`);
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
  const output = status === "running" && !finalOutput
    ? "Child process is still running; output may update."
    : finalOutput || getResultSummaryText(r);
  pushSection(lines, "Output", output);

  if (isResultError(r) && r.stderr?.trim()) pushSection(lines, "Stderr", r.stderr.trim());
  const usage = formatUsage(r);
  if (usage) pushSection(lines, "Usage", usage);
  return lines;
}

export function getSubagentTreeSignature(root: SubagentTreeNode): string {
  return stableStringify(serializeNode(root));
}

export function findFlatNodeIndexById(flat: FlatSubagentNode[], id: string): number {
  return flat.findIndex((row) => row.node.id === id);
}

export function preserveSelectionIndex(
  flat: FlatSubagentNode[],
  previousSelectedId: string | null,
  previousSelectedIndex: number,
): number {
  if (previousSelectedId) {
    const byId = findFlatNodeIndexById(flat, previousSelectedId);
    if (byId >= 0) return byId;
  }
  return flat.length === 0 ? 0 : Math.max(0, Math.min(previousSelectedIndex, flat.length - 1));
}

export function summarizeSubagentTree(root: SubagentTreeNode): SubagentTreeSummary {
  const summary: SubagentTreeSummary = {
    total: 0,
    turns: 0,
    subagents: 0,
    pending: 0,
    running: 0,
    streaming: 0,
    success: 0,
    error: 0,
    cancelled: 0,
    mixed: 0,
  };

  const visit = (node: SubagentTreeNode): void => {
    if (node.kind !== "session" && node.kind !== "root") {
      summary.total++;
      if (node.kind === "active-agent-turn") summary.turns++;
      if (node.kind === "subagent" || node.kind === "agent") summary.subagents++;
      summary[node.status]++;
    }
    for (const child of node.children) visit(child);
  };

  for (const child of root.children) visit(child);
  return summary;
}

export function preserveDetailScrollAfterRefresh(
  previousMode: string,
  previousSelectedNodeId: string | null,
  nextSelectedNode: SubagentTreeNode | undefined,
  previousDetailScroll: number,
): number {
  if (previousMode !== "detail") return 0;
  if (!nextSelectedNode || nextSelectedNode.kind === "root") return 0;
  if (nextSelectedNode.id !== previousSelectedNodeId) return 0;
  const wrappedDetailLength = buildAgentDetailLines(nextSelectedNode).length;
  const maxScroll = Math.max(0, wrappedDetailLength - 22);
  return Math.max(0, Math.min(previousDetailScroll, maxScroll));
}
