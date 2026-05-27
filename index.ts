/**
 * Pi Subagent Extension
 *
 * Delegates tasks to specialized subagents, each running as an isolated `pi`
 * process.
 *
 * Supports a single invocation shape:
 *   - Single: { agent: "name", task: "..." }
 *
 * Context modes:
 *   - spawn (default): child gets only the task prompt.
 *   - fork: child gets a forked snapshot of current session context + task prompt.
 *   - continue: resume a single-mode lineId checkpoint.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { matchesKey } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents, getVisibleAgents } from "./agents.js";
import { loadSubagentConfig, resolveStartupAgentName } from "./config.js";
import { buildForkSessionSnapshotJsonl, type SessionSnapshotSource } from "./fork-snapshot.js";
import { findVisibleLine, formatAvailableLines } from "./line-history.js";
import { renderCall, renderResult } from "./render.js";
import { openSubagentViewer, type SubagentViewerContext } from "./subagent-tree-view.js";
import { createActivityStore, type ActivityStore } from "./subagent-view-data.js";
import { materializeCheckpointSnapshot, needsCopyOnWrite } from "./session-checkpoint.js";
import { getResultSummaryText } from "./runner-events.js";
import { withLineLock } from "./line-lock.js";
import { runAgent } from "./runner.js";
import { getWorktreeFingerprint, hasWorktreeDrift, WORKTREE_DRIFT_TASK_PREFIX } from "./worktree-fingerprint.js";
import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  DEFAULT_DELEGATION_MODE,
  isResultError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name for single mode. Must match an available agent name exactly.",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "Task description for single mode. In spawn mode it must be self-contained; in fork mode the subagent also receives your current session context.",
    }),
  ),
  mode: Type.Optional(
    Type.String({
      description:
        "Context mode. Default to 'spawn' for new independent tasks; the child sees only the task prompt, so task must be self-contained. Use 'fork' only when the child needs the current main conversation context. Use 'continue' only to resume a previously created single-mode line with the same agent + lineId; do not use continue for new tasks.",
      default: DEFAULT_DELEGATION_MODE,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent process (single mode only)",
    }),
  ),
  lineId: Type.Optional(
    Type.String({
      description:
        "Caller-chosen reusable line id. Add to spawn/fork to create a checkpoint; required with mode='continue' to resume it."
    }),
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DelegationDepthConfig {
  currentDepth: number;
  maxDepth: number;
  canDelegate: boolean;
  ancestorAgentStack: string[];
  preventCycles: boolean;
}

function parseDelegationMode(raw: unknown): DelegationMode | null {
  if (raw === undefined) return DEFAULT_DELEGATION_MODE;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "spawn" || normalized === "fork" || normalized === "continue") {
    return normalized;
  }
  return null;
}

function parseNonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseAgentStack(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((value) => typeof value === "string")) return null;
  return parsed
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getMaxDepthFlagFromArgv(argv: string[]): string | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-max-depth") {
      return argv[i + 1] ?? "";
    }
    if (arg.startsWith("--subagent-max-depth=")) {
      return arg.slice("--subagent-max-depth=".length);
    }
  }
  return null;
}

function getPreventCyclesFlagFromArgv(
  argv: string[],
): string | boolean | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-prevent-cycles") {
      const maybeValue = argv[i + 1];
      if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
        return maybeValue;
      }
      return true;
    }
    if (arg === "--no-subagent-prevent-cycles") return false;
    if (arg.startsWith("--subagent-prevent-cycles=")) {
      return arg.slice("--subagent-prevent-cycles=".length);
    }
  }
  return null;
}

function resolveDelegationDepthConfig(pi: ExtensionAPI): DelegationDepthConfig {
  const depthRaw = process.env[SUBAGENT_DEPTH_ENV];
  const parsedDepth = parseNonNegativeInt(depthRaw);
  if (depthRaw !== undefined && parsedDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_DEPTH_ENV}="${depthRaw}". Expected a non-negative integer.`,
    );
  }
  const currentDepth = parsedDepth ?? 0;

  const stackRaw = process.env[SUBAGENT_STACK_ENV];
  const ancestorAgentStack = parseAgentStack(stackRaw);
  if (stackRaw !== undefined && ancestorAgentStack === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_STACK_ENV} value. Expected a JSON array of agent names.`,
    );
  }

  const envMaxDepthRaw = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
  if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
    );
  }

  const argvFlagRaw = getMaxDepthFlagFromArgv(process.argv);
  const argvFlagMaxDepth =
    argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
  if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
    );
  }

  const runtimeFlagValue = pi.getFlag("subagent-max-depth");
  const runtimeFlagMaxDepth =
    typeof runtimeFlagValue === "string"
      ? parseNonNegativeInt(runtimeFlagValue)
      : null;
  if (
    argvFlagRaw === null &&
    typeof runtimeFlagValue === "string" &&
    runtimeFlagMaxDepth === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${runtimeFlagValue}". Expected a non-negative integer.`,
    );
  }

  const envPreventCyclesRaw = process.env[SUBAGENT_PREVENT_CYCLES_ENV];
  const envPreventCycles = parseBoolean(envPreventCyclesRaw);
  if (envPreventCyclesRaw !== undefined && envPreventCycles === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_PREVENT_CYCLES_ENV}="${envPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(process.argv);
  const argvPreventCycles =
    typeof argvPreventCyclesRaw === "boolean"
      ? argvPreventCyclesRaw
      : parseBoolean(argvPreventCyclesRaw);
  if (
    typeof argvPreventCyclesRaw === "string" &&
    argvPreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const runtimePreventCyclesRaw = pi.getFlag("subagent-prevent-cycles");
  const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
  if (
    argvPreventCyclesRaw === null &&
    runtimePreventCyclesRaw !== undefined &&
    runtimePreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
    );
  }

  const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
  const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const preventCycles =
    argvPreventCycles ??
    runtimePreventCycles ??
    envPreventCycles ??
    DEFAULT_PREVENT_CYCLE_DELEGATION;

  return {
    currentDepth,
    maxDepth,
    canDelegate: currentDepth < maxDepth,
    ancestorAgentStack: ancestorAgentStack ?? [],
    preventCycles,
  };
}

function makeDetailsFactory(
  projectAgentsDir: string | null,
  delegationMode: DelegationMode,
) {
  return (results: SingleResult[]): SubagentDetails => ({
    mode: "single",
    delegationMode,
    projectAgentsDir,
    results,
  });
}

function formatAgentNames(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

function formatVisibleAgentNames(agents: AgentConfig[]): string {
  const visible = getVisibleAgents(agents);
  return visible.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

function resolveAgentByExactName(agents: AgentConfig[], name: string): AgentConfig | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return agents.find((agent) => agent.name === trimmed);
}

function resolveModelReference(ctx: ExtensionContext, reference: string): Model<any> | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;

  const allModels = ctx.modelRegistry.getAll();
  if (trimmed.includes("/")) {
    const slashIdx = trimmed.indexOf("/");
    const provider = trimmed.slice(0, slashIdx).trim();
    const modelId = trimmed.slice(slashIdx + 1).trim();
    if (provider && modelId) {
      const resolved = ctx.modelRegistry.find(provider, modelId);
      if (resolved) return resolved;
    }
  }

  const canonicalMatches = allModels.filter((model) => `${model.provider}/${model.id}` === trimmed);
  if (canonicalMatches.length === 1) return canonicalMatches[0];

  const exactIdMatches = allModels.filter((model) => model.id === trimmed);
  if (exactIdMatches.length === 1) return exactIdMatches[0];
  if (exactIdMatches.length > 1) {
    console.warn(
      `[pi-subagent] Agent model reference "${reference}" is ambiguous across providers. Use provider/model-id form instead.`,
    );
  }

  return undefined;
}

interface ActiveAgentRuntimeState {
  baseline?: {
    model: Model<any> | undefined;
    thinkingLevel: ThinkingLevel;
    tools: string[];
  };
  activeAgentName?: string;
  activeAgent?: AgentConfig;
}

function updateActiveAgentStatus(ctx: ExtensionContext, activeAgent?: AgentConfig): void {
  const statusText = activeAgent ? ctx.ui.theme.fg("accent", `agent:${activeAgent.name}`) : undefined;
  ctx.ui.setStatus("active-agent", statusText);
  ctx.ui.setWidget(
    "active-agent",
    activeAgent ? [ctx.ui.theme.fg("accent", `Active agent: ${activeAgent.name}`)] : undefined,
  );
}

async function restoreBaselineAgentState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ActiveAgentRuntimeState,
): Promise<void> {
  if (!state.baseline) return;
  const { model, thinkingLevel, tools } = state.baseline;
  if (model) {
    await pi.setModel(model);
  }
  pi.setThinkingLevel(thinkingLevel);
  pi.setActiveTools(tools);
}

async function applyActiveAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ActiveAgentRuntimeState,
  agent: AgentConfig,
): Promise<void> {
  if (!state.baseline) {
    state.baseline = {
      model: ctx.model,
      thinkingLevel: pi.getThinkingLevel(),
      tools: pi.getActiveTools(),
    };
  }

  await restoreBaselineAgentState(pi, ctx, state);

  if (agent.model) {
    const model = resolveModelReference(ctx, agent.model);
    if (model) {
      const success = await pi.setModel(model);
      if (!success) {
        ctx.ui.notify(`Agent "${agent.name}": No API key for ${agent.model}`, "warning");
      }
    } else {
      ctx.ui.notify(`Agent "${agent.name}": Model ${agent.model} not found`, "warning");
    }
  }

  if (agent.thinking) {
    pi.setThinkingLevel(agent.thinking as ReturnType<ExtensionAPI["getThinkingLevel"]>);
  }

  if (agent.tools !== undefined) {
    pi.setActiveTools(agent.tools);
  }

  state.activeAgentName = agent.name;
  state.activeAgent = agent;
  updateActiveAgentStatus(ctx, agent);
}

async function clearActiveAgent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ActiveAgentRuntimeState,
): Promise<void> {
  await restoreBaselineAgentState(pi, ctx, state);
  state.activeAgentName = undefined;
  state.activeAgent = undefined;
  updateActiveAgentStatus(ctx, undefined);
}

function getAllToolNames(pi: ExtensionAPI): string[] {
  const getAllTools = (pi as ExtensionAPI & { getAllTools?: () => Array<{ name: string }> }).getAllTools;
  if (typeof getAllTools !== "function") return [];
  return getAllTools().map((tool) => tool.name).filter(Boolean);
}

function getCycleViolations(
  requestedNames: Set<string>,
  ancestorAgentStack: string[],
): string[] {
  if (requestedNames.size === 0 || ancestorAgentStack.length === 0) return [];
  const stackSet = new Set(ancestorAgentStack);
  return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

interface AvailableSubagentsSectionOptions {
  visibleAgents: AgentConfig[];
  currentDepth: number;
  maxDepth: number;
  preventCycles: boolean;
  ancestorAgentStack: string[];
}

function buildAvailableSubagentsSection({
  visibleAgents,
  currentDepth,
  maxDepth,
  preventCycles,
  ancestorAgentStack,
}: AvailableSubagentsSectionOptions): string | undefined {
  if (visibleAgents.length === 0) return undefined;

  const agentList = visibleAgents
    .map((a) => `- **${a.name}**: ${a.description}`)
    .join("\n");

  return `## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

### How to call the subagent tool

Each subagent runs in an **isolated process**.

Context behavior is controlled by optional 'mode':
- 'spawn' (default): child receives only the provided task prompt.
- 'fork': child receives a forked snapshot of current session context plus the task prompt.
- 'continue': resume a previous single-mode checkpoint by agent + lineId.

Call subagent once per delegated task.

**Single mode** — delegate one task:
\`\`\`json
{ "agent": "agent-name", "task": "Detailed task...", "mode": "spawn" }
\`\`\`

**Reusable line** — choose your own lineId on spawn/fork if you may continue later:
\`\`\`json
{ "agent": "agent-name", "mode": "spawn", "lineId": "short-stable-name", "task": "Start work..." }
{ "agent": "agent-name", "mode": "continue", "lineId": "short-stable-name", "task": "Continue work..." }
\`\`\`

### Runtime delegation guards

- Max depth: current depth ${currentDepth}, max depth ${maxDepth}
- Cycle prevention: ${preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${ancestorAgentStack.length > 0 ? ancestorAgentStack.join(" -> ") : "(root)"}`;
}

function trimmedNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildActiveAgentSection(agent: AgentConfig): string {
  const body = trimmedNonEmpty(agent.systemPrompt);
  return body ? `# Active Agent: ${agent.name}\n\n${body}` : `# Active Agent: ${agent.name}`;
}

function buildUserPromptAdditions(options: BuildSystemPromptOptions): string | undefined {
  const sections: string[] = [];
  const customPrompt = trimmedNonEmpty(options.customPrompt);
  if (customPrompt) {
    sections.push(`## Additional System Prompt\n\n${customPrompt}`);
  }

  const appendSystemPrompt = trimmedNonEmpty(options.appendSystemPrompt);
  if (appendSystemPrompt) {
    sections.push(`## Appended System Prompt\n\n${appendSystemPrompt}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function getSelectedTools(options: BuildSystemPromptOptions): string[] {
  return options.selectedTools ?? [];
}

function getGuidelineTools(options: BuildSystemPromptOptions): string[] {
  return options.selectedTools ?? ["read", "bash", "edit", "write"];
}

function buildAvailableToolsSection(options: BuildSystemPromptOptions): string {
  const selectedTools = getSelectedTools(options);
  const toolSnippets = options.toolSnippets ?? {};
  const visibleTools = selectedTools
    .map((name) => ({ name, snippet: trimmedNonEmpty(toolSnippets[name]) }))
    .filter((tool): tool is { name: string; snippet: string } => Boolean(tool.snippet));
  const toolsList = visibleTools.length > 0
    ? visibleTools.map(({ name, snippet }) => `- ${name}: ${snippet}`).join("\n")
    : "(none)";

  return `## Available tools\n\n${toolsList}`;
}

function buildGuidelinesSection(options: BuildSystemPromptOptions): string {
  const tools = getGuidelineTools(options);
  const guidelines: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (guideline: string) => {
    const normalized = guideline.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    guidelines.push(normalized);
  };

  const hasBash = tools.includes("bash");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");
  const hasLs = tools.includes("ls");

  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
  }

  for (const guideline of options.promptGuidelines ?? []) {
    addGuideline(guideline);
  }

  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");

  return `## Guidelines\n\n${guidelines.map((guideline) => `- ${guideline}`).join("\n")}`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildProjectContextSection(options: BuildSystemPromptOptions): string | undefined {
  const contextFiles = options.contextFiles ?? [];
  if (contextFiles.length === 0) return undefined;

  const fileSections = contextFiles
    .map(({ path: filePath, content }) => `<project_instructions path="${escapeXmlAttribute(filePath)}">\n${content}\n</project_instructions>`)
    .join("\n\n");

  return `<project_context>\n\nProject-specific instructions and guidelines:\n\n${fileSections}\n\n</project_context>`;
}

function buildSkillsSection(options: BuildSystemPromptOptions): string | undefined {
  const skills = options.skills ?? [];
  if (skills.length === 0) return undefined;
  const hasRead = !options.selectedTools || options.selectedTools.includes("read");
  if (!hasRead) return undefined;

  const formatted = formatSkillsForPrompt(skills).trim();
  return formatted.length > 0 ? formatted : undefined;
}

function getCurrentDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDateCwdSection(cwd: string): string {
  const promptCwd = (cwd || process.cwd()).replace(/\\/g, "/");
  return `Current date: ${getCurrentDateString()}\nCurrent working directory: ${promptCwd}`;
}

function shouldIncludeSubagentsInActivePrompt(options: BuildSystemPromptOptions): boolean {
  return !options.selectedTools || options.selectedTools.includes("subagent");
}

function buildActiveAgentSystemPrompt(input: {
  agent: AgentConfig;
  visibleAgents: AgentConfig[];
  systemPromptOptions: BuildSystemPromptOptions;
  subagentsSectionOptions: Omit<AvailableSubagentsSectionOptions, "visibleAgents">;
}): string {
  const { agent, visibleAgents, systemPromptOptions, subagentsSectionOptions } = input;
  const subagentsSection = shouldIncludeSubagentsInActivePrompt(systemPromptOptions)
    ? buildAvailableSubagentsSection({
      ...subagentsSectionOptions,
      visibleAgents,
    })
    : undefined;

  const sections = [
    buildActiveAgentSection(agent),
    buildUserPromptAdditions(systemPromptOptions),
    buildAvailableToolsSection(systemPromptOptions),
    buildGuidelinesSection(systemPromptOptions),
    subagentsSection,
    buildProjectContextSection(systemPromptOptions),
    buildSkillsSection(systemPromptOptions),
    buildDateCwdSection(systemPromptOptions.cwd),
  ];

  return sections.filter((section): section is string => Boolean(section)).join("\n\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let viewerOpen = false;
  const activityStore: ActivityStore = createActivityStore();

  function getSessionIdFromHeader(header: unknown): string | null {
    if (!header || typeof header !== "object") return null;
    const maybe = header as { id?: unknown };
    return typeof maybe.id === "string" && maybe.id.trim() ? maybe.id : null;
  }

  function getMessageRole(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const maybe = value as { role?: unknown };
    return typeof maybe.role === "string" ? maybe.role : null;
  }

  function getMessageText(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const maybe = value as { content?: unknown };
    if (typeof maybe.content === "string") return maybe.content;
    if (!Array.isArray(maybe.content)) return null;
    const parts: string[] = [];
    for (const part of maybe.content) {
      if (part && typeof part === "object") {
        const item = part as { type?: unknown; text?: unknown };
        if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
          parts.push(item.text);
        }
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }

  function syncStoreFromBranch(ctx: ExtensionContext): void {
    try {
      const manager = ctx.sessionManager as Partial<ExtensionContext["sessionManager"]> | undefined;
      if (!manager || typeof manager.getBranch !== "function") return;
      const branch = manager.getBranch();
      const header = typeof manager.getHeader === "function" ? manager.getHeader() : undefined;
      activityStore.reconcileBranch(Array.isArray(branch) ? branch : [], header);
    } catch {
      /* ignore live-store reconciliation errors */
    }
  }

  function handleAgentTurnStart(event: unknown): void {
    const turnIndex = event && typeof event === "object" && typeof (event as { turnIndex?: unknown }).turnIndex === "number"
      ? (event as { turnIndex: number }).turnIndex
      : undefined;
    activityStore.beginActiveAgentTurn({ turnIndex, status: "running", isCurrent: true });
  }

  function handleAssistantMessage(event: unknown): void {
    const message = event && typeof event === "object" ? (event as { message?: unknown }).message : undefined;
    const role = getMessageRole(message);
    if (role === "assistant") {
      const text = getMessageText(message);
      activityStore.updateActiveAgentTurn({
        status: "streaming",
        streamingText: text ?? undefined,
        finalText: text ?? undefined,
      });
    }
  }

  function handleToolExecution(event: unknown, phase: "start" | "update" | "end"): void {
    if (!event || typeof event !== "object") return;
    const toolName = typeof (event as { toolName?: unknown }).toolName === "string" ? (event as { toolName: string }).toolName : undefined;
    const toolCallId = typeof (event as { toolCallId?: unknown }).toolCallId === "string" ? (event as { toolCallId: string }).toolCallId : undefined;
    if (toolName !== "subagent") return;

    const args = phase === "start" || phase === "update"
      ? (event as { args?: unknown }).args
      : undefined;
    const isError = typeof (event as { isError?: unknown }).isError === "boolean"
      ? (event as { isError: boolean }).isError
      : false;
    const result = phase === "end"
      ? (event as { result?: unknown }).result
      : phase === "update"
        ? (event as { partialResult?: unknown }).partialResult
        : undefined;

    if (phase === "start") {
      activityStore.startSubagentTool({ toolCallId, toolName, args, status: "running" });
    } else if (phase === "update") {
      activityStore.updateSubagentTool({ toolCallId, toolName, args, result, status: "streaming" });
    } else {
      activityStore.endSubagentTool({ toolCallId, toolName, args, result, isError, status: isError ? "error" : "success" });
    }
  }

  async function guardedOpenSubagentViewer(ctx: SubagentViewerContext): Promise<void> {
    if (!ctx.hasUI) return;
    if (viewerOpen) return;
    viewerOpen = true;
    try {
      await openSubagentViewer({ ...ctx, activityStore });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify?.(`Subagent viewer failed: ${message}`, "error");
    } finally {
      viewerOpen = false;
    }
  }

  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 3).",
    type: "string",
  });
  pi.registerFlag("agent", {
    description: "Active agent to apply at startup.",
    type: "string",
  });
  pi.registerFlag("subagent-prevent-cycles", {
    description:
      "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });

  const depthConfig = resolveDelegationDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;

  let discoveredAgents: AgentConfig[] = [];
  const activeAgentState: ActiveAgentRuntimeState = {};

  function getVisibleDiscoveredAgents(): AgentConfig[] {
    return getVisibleAgents(discoveredAgents);
  }

  function getVisibleAgentNames(): string[] {
    return getVisibleDiscoveredAgents().map((agent) => agent.name);
  }

  function getNextAgentInCycle(): AgentConfig | undefined {
    const visible = getVisibleDiscoveredAgents();
    if (visible.length === 0) return undefined;
    if (!activeAgentState.activeAgentName) return visible[0];

    const currentIndex = visible.findIndex((agent) => agent.name === activeAgentState.activeAgentName);
    if (currentIndex === -1) return visible[0];
    if (currentIndex >= visible.length - 1) return undefined;
    return visible[currentIndex + 1];
  }

  async function cycleActiveAgent(ctx: ExtensionContext): Promise<void> {
    const next = getNextAgentInCycle();
    if (!next) {
      await clearActiveAgent(pi, ctx, activeAgentState);
      ctx.ui.notify("Active agent cleared.", "info");
      return;
    }

    await applyActiveAgent(pi, ctx, activeAgentState, next);
    ctx.ui.notify(`Active agent: ${next.name}`, "info");
  }

  async function setActiveAgentByName(name: string, ctx: ExtensionContext): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === "none" || trimmed === "clear") {
      await clearActiveAgent(pi, ctx, activeAgentState);
      ctx.ui.notify("Active agent cleared.", "info");
      return;
    }

    const agent = resolveAgentByExactName(discoveredAgents, trimmed);
    if (!agent) {
      ctx.ui.notify(`Unknown agent: ${trimmed}`, "warning");
      return;
    }

    await applyActiveAgent(pi, ctx, activeAgentState, agent);
    ctx.ui.notify(`Active agent: ${agent.name}`, "info");
  }

  async function openAgentSelector(ctx: ExtensionContext): Promise<void> {
    const visible = getVisibleDiscoveredAgents();
    const choices = ["(none)", ...visible.map((agent) => agent.name)];
    const selected = await ctx.ui.select("Select active agent", choices);
    if (!selected) return;
    if (selected === "(none)") {
      await clearActiveAgent(pi, ctx, activeAgentState);
      ctx.ui.notify("Active agent cleared.", "info");
      return;
    }
    const agent = resolveAgentByExactName(discoveredAgents, selected);
    if (agent) {
      await applyActiveAgent(pi, ctx, activeAgentState, agent);
      ctx.ui.notify(`Active agent: ${agent.name}`, "info");
    }
  }

  pi.registerCommand("subagents", {
    description: "Open subagent viewer",
    handler: async (_args, ctx) => {
      await guardedOpenSubagentViewer(ctx);
    },
  });

  pi.registerCommand("agent", {
    description: "Set the active agent for future turns",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const items = getVisibleAgentNames()
        .filter((name) => name.toLowerCase().startsWith(normalized))
        .map((name) => ({ value: name, label: name }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Agent selector requires UI mode.", "warning");
          return;
        }
        await openAgentSelector(ctx);
        return;
      }
      await setActiveAgentByName(trimmed, ctx);
    },
  });

  // Auto-discover agents on session start
  pi.on("session_start", async (_event, ctx) => {
    activeAgentState.baseline = undefined;
    activeAgentState.activeAgentName = undefined;
    activeAgentState.activeAgent = undefined;
    updateActiveAgentStatus(ctx, undefined);
    const header = (ctx.sessionManager as Partial<ExtensionContext["sessionManager"]> | undefined)?.getHeader?.();
    activityStore.reset(getSessionIdFromHeader(header));
    syncStoreFromBranch(ctx);

    const config = loadSubagentConfig(ctx.cwd);
    if (ctx.hasUI) {
      const ui = ctx.ui as typeof ctx.ui & {
        onTerminalInput?: (handler: (data: string) => { consume: boolean } | undefined) => void;
      };
      if (config.viewerKey !== "none" && typeof ui.onTerminalInput === "function") {
        const viewerKey = config.viewerKey;
        ui.onTerminalInput((data: string) => {
          if (viewerOpen) return undefined;
          if (!matchesKey(data, viewerKey)) return undefined;
          void guardedOpenSubagentViewer(ctx);
          return { consume: true };
        });
      }
      if (config.cycleAgentKey !== "none" && typeof ui.onTerminalInput === "function") {
        const cycleAgentKey = config.cycleAgentKey;
        ui.onTerminalInput((data: string) => {
          if (viewerOpen) return undefined;
          if (!matchesKey(data, cycleAgentKey)) return undefined;
          void cycleActiveAgent(ctx);
          return { consume: true };
        });
      }
    }

    if (!canDelegate) return;

    const discovery = discoverAgents(ctx.cwd, "both", getAllToolNames(pi));
    discoveredAgents = discovery.agents;

    const cliAgent = pi.getFlag("agent");
    const hasCliAgent = typeof cliAgent === "string" && cliAgent.trim().length > 0;
    const requestedAgent = resolveStartupAgentName(
      cliAgent,
      config,
      currentDepth === 0,
    );
    if (requestedAgent) {
      const requested = resolveAgentByExactName(discoveredAgents, requestedAgent);
      if (requested) {
        await applyActiveAgent(pi, ctx, activeAgentState, requested);
      } else {
        const warning = !hasCliAgent
          ? `Unknown default agent: ${requestedAgent}`
          : `Unknown agent: ${requestedAgent}`;
        if (ctx.hasUI) {
          ctx.ui.notify(warning, "warning");
        } else {
          console.warn(`[pi-subagent] ${warning}`);
        }
      }
    }

    const visibleAgents = getVisibleDiscoveredAgents();
    if (visibleAgents.length > 0 && ctx.hasUI) {
      const list = visibleAgents
        .map((a) => `  - ${a.name} (${a.source})`)
        .join("\n");
      ctx.ui.notify(
        `Found ${visibleAgents.length} subagent(s):\n${list}`,
        "info",
      );
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    activityStore.beginActiveAgentTurn({ status: "running", isCurrent: true });
    syncStoreFromBranch(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    const turnIndex = typeof (event as { turnIndex?: unknown }).turnIndex === "number"
      ? (event as { turnIndex: number }).turnIndex
      : undefined;
    activityStore.beginActiveAgentTurn({ turnIndex, status: "running", isCurrent: true });
    syncStoreFromBranch(ctx);
  });

  pi.on("message_update", async (event, _ctx) => {
    const message = (event as { message?: unknown }).message;
    const role = getMessageRole(message);
    if (role !== "assistant") return;
    const assistantEvent = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent;
    const delta = assistantEvent && typeof assistantEvent === "object" && typeof (assistantEvent as { delta?: unknown }).delta === "string"
      ? (assistantEvent as { delta: string }).delta
      : null;
    const current = activityStore.getCurrentTurn();
    const nextText = delta
      ? `${current?.streamingText ?? ""}${delta}`
      : getMessageText(message) ?? current?.streamingText;
    activityStore.updateActiveAgentTurn({
      status: "streaming",
      streamingText: nextText ?? undefined,
    });
  });

  pi.on("message_end", async (event, _ctx) => {
    const message = (event as { message?: unknown }).message;
    const role = getMessageRole(message);
    if (role === "user") {
      const text = getMessageText(message);
      if (text) activityStore.noteUserInput(text);
      return;
    }
    if (role !== "assistant") return;
    const text = getMessageText(message);
    activityStore.updateActiveAgentTurn({
      status: "streaming",
      streamingText: text ?? undefined,
      finalText: text ?? undefined,
    });
  });

  pi.on("tool_execution_start", async (event, _ctx) => {
    handleToolExecution(event, "start");
  });

  pi.on("tool_execution_update", async (event, _ctx) => {
    handleToolExecution(event, "update");
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    handleToolExecution(event, "end");
  });

  pi.on("turn_end", async (event, _ctx) => {
    const message = (event as { message?: unknown }).message;
    const role = getMessageRole(message);
    if (role === "assistant") {
      const text = getMessageText(message);
      activityStore.updateActiveAgentTurn({
        status: "success",
        streamingText: text ?? undefined,
        finalText: text ?? undefined,
      });
    }
    activityStore.endActiveAgentTurn({
      status: "success",
      turnIndex: typeof (event as { turnIndex?: unknown }).turnIndex === "number"
        ? (event as { turnIndex: number }).turnIndex
        : undefined,
    });
  });

  pi.on("agent_end", async (_event, _ctx) => {
    activityStore.endActiveAgentTurn({ status: "success" });
  });

  // Inject available agents into the system prompt, or replace it for active-agent mode.
  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    const visibleAgents = getVisibleDiscoveredAgents();

    const subagentsSectionOptions = {
      currentDepth,
      maxDepth,
      preventCycles,
      ancestorAgentStack,
    };

    if (activeAgentState.activeAgent) {
      return {
        systemPrompt: buildActiveAgentSystemPrompt({
          agent: activeAgentState.activeAgent,
          visibleAgents,
          systemPromptOptions: event.systemPromptOptions,
          subagentsSectionOptions,
        }),
      };
    }

    const availableSubagentsSection = buildAvailableSubagentsSection({
      ...subagentsSectionOptions,
      visibleAgents,
    });
    if (!availableSubagentsSection) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${availableSubagentsSection}`,
    };
  });

  // Register the subagent tool
  if (canDelegate) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: [
        "Delegate work to specialized subagents running in isolated pi processes.",
        "",
        "IMPORTANT: Use exactly ONE invocation shape:",
        "  Single mode: set `agent` and `task` (both required together).",
        "",
        "Optional context mode switch:",
        "  mode: \"spawn\" (default) -> child gets only your task prompt.",
        "                             Best for isolated/reproducible work; lower token/cost and less context leakage.",
        "  mode: \"fork\"            -> child gets current session context + your task prompt.",
        "                             Best for follow-up work that depends on prior context; higher token/cost and may include sensitive context.",
        "  mode: \"continue\"        -> continue a previous lineId checkpoint (single mode only; lineId required).",
        "",
        "lineId: caller-chosen reusable name. Add it to spawn/fork to create a checkpoint; reuse it with mode=\"continue\".",
        "",
        'Example single:   { agent: "writer", task: "Rewrite README.md", mode: "spawn" }',
        'Example line:     { agent: "writer", mode: "spawn", lineId: "readme", task: "Start README work" }',
        'Example continue: { agent: "writer", mode: "continue", lineId: "readme", task: "Continue README work" }',
      ].join("\n"),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const discovery = discoverAgents(ctx.cwd, "both", getAllToolNames(pi));
        const { agents } = discovery;

        const delegationMode = parseDelegationMode(params.mode);
        if (!delegationMode) {
          const fallbackDetails = makeDetailsFactory(
            discovery.projectAgentsDir,
            DEFAULT_DELEGATION_MODE,
          );
          return {
            content: [
              {
                type: "text",
                text: `Invalid mode "${String(params.mode)}". Expected "spawn", "fork", or "continue".
Available agents: ${formatAgentNames(agents)}`,
              },
            ],
            details: fallbackDetails([]),
            isError: true,
          };
        }

        const makeDetails = makeDetailsFactory(
          discovery.projectAgentsDir,
          delegationMode,
        );

        if ((params as Record<string, unknown>).tasks !== undefined) {
          return {
            content: [
              {
                type: "text",
                text: "Parallel mode was removed. Call subagent separately for each agent.",
              },
            ],
            details: makeDetails([]),
            isError: true,
          };
        }

        const agent = trimmedNonEmpty(params.agent);
        const task = trimmedNonEmpty(params.task);
        if (!agent || !task) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid parameters. Provide agent and task.",
              },
            ],
            details: makeDetails([]),
            isError: true,
          };
        }

        if (delegationMode === "continue" && (!params.lineId || !params.lineId.trim())) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid parameters: mode=\"continue\" requires lineId. No default line is selected automatically.",
              },
            ],
            details: makeDetails([]),
            isError: true,
          };
        }

        let forkSessionSnapshotJsonl: string | undefined;
        if (delegationMode === "fork") {
          forkSessionSnapshotJsonl = buildForkSessionSnapshotJsonl(
            ctx.sessionManager,
          );
          if (!forkSessionSnapshotJsonl) {
            return {
              content: [
                {
                  type: "text",
                  text: "Cannot use mode=\"fork\": failed to snapshot current session context.",
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        const requested = new Set<string>([agent]);

        if (preventCycles) {
          const cycleViolations = getCycleViolations(
            requested,
            ancestorAgentStack,
          );
          if (cycleViolations.length > 0) {
            const stackText =
              ancestorAgentStack.length > 0
                ? ancestorAgentStack.join(" -> ")
                : "(root)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
        }

        let continueSessionFile: string | undefined;
        let continuedFrom: { childSessionId: string; childSessionFile?: string; childLeafId?: string } | undefined;
        let warning: string | undefined;
        let copyOnWrite = false;
        let effectiveTask = task;
        const effectiveCwd = params.cwd ?? ctx.cwd;
        const worktree = getWorktreeFingerprint(effectiveCwd);
        if (delegationMode === "continue") {
          const lineId = params.lineId!.trim();
          const visibleLine = findVisibleLine(ctx.sessionManager.getBranch(), agent, lineId);
          if (!visibleLine) {
            const available = formatAvailableLines(ctx.sessionManager.getBranch(), agent);
            return {
              content: [
                {
                  type: "text",
                  text: `No line "${lineId}" for agent "${agent}" in current branch, or it is outside the latest 3 visible lines.

Available lines for this agent in the current branch:
${available}`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
          if (!visibleLine.event.childSessionFile) {
            return {
              content: [
                {
                  type: "text",
                  text: `Cannot continue line "${lineId}" for agent "${agent}": the checkpoint is missing childSessionFile. Re-open this line with spawn/fork and lineId to create a resumable checkpoint.`,
                },
              ],
              details: makeDetails([]),
              isError: true,
            };
          }
          continueSessionFile = visibleLine.event.childSessionFile;
          continuedFrom = {
            childSessionId: visibleLine.event.childSessionId,
            childSessionFile: visibleLine.event.childSessionFile,
            childLeafId: visibleLine.event.childLeafId,
          };
          if (needsCopyOnWrite(continueSessionFile, visibleLine.event.childLeafId)) {
            const materialized = materializeCheckpointSnapshot(continueSessionFile, visibleLine.event.childLeafId!);
            continueSessionFile = materialized.sessionFile;
            copyOnWrite = true;
          }
          if (hasWorktreeDrift(visibleLine.event.worktree, worktree)) {
            warning = "Worktree drift detected since this subagent line was last used. The task was prefixed with a reminder to re-read files.";
            effectiveTask = `${WORKTREE_DRIFT_TASK_PREFIX}${effectiveTask}`;
          }
        }

        const lineId = params.lineId?.trim();
        const runSingle = () => executeSingle(
          agent,
          effectiveTask,
          params.cwd,
          delegationMode,
          forkSessionSnapshotJsonl,
          agents,
          ctx.cwd,
          signal,
          onUpdate,
          makeDetails,
          lineId,
          continueSessionFile,
          continuedFrom,
          worktree,
          warning,
          copyOnWrite,
        );

        if (!lineId) return runSingle();

        const parentHeader = ctx.sessionManager.getHeader();
        const parentSessionId =
          parentHeader && typeof parentHeader === "object" && "id" in parentHeader
            ? String((parentHeader as { id?: unknown }).id ?? "unknown")
            : "unknown";
        const lockKey = `${parentSessionId}:${agent}:${lineId}`;
        try {
          return await withLineLock(lockKey, runSingle);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: message,
              },
            ],
            details: makeDetails([]),
            isError: true,
          };
        }
      },

      renderCall: (args, theme) => renderCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderResult(result, expanded, theme),
    });
  }

  // -----------------------------------------------------------------------
  // Mode implementations
  // -----------------------------------------------------------------------

  async function executeSingle(
    agentName: string,
    task: string,
    cwd: string | undefined,
    delegationMode: DelegationMode,
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: (results: SingleResult[]) => SubagentDetails,
    lineId?: string,
    continueSessionFile?: string,
    continuedFrom?: { childSessionId: string; childSessionFile?: string; childLeafId?: string },
    worktree?: import("./types.js").WorktreeFingerprint,
    warning?: string,
    copyOnWrite?: boolean,
  ) {
    const result = await runAgent({
      cwd: defaultCwd,
      agents,
      agentName,
      task,
      taskCwd: cwd,
      delegationMode,
      forkSessionSnapshotJsonl,
      continueSessionFile,
      lineId,
      continuedFrom,
      worktree,
      warning,
      copyOnWrite,
      parentDepth: currentDepth,
      parentAgentStack: ancestorAgentStack,
      maxDepth,
      preventCycles,
      signal,
      onUpdate,
      makeDetails,
    });

    if (isResultError(result)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${result.stopReason || "failed"}: ${getResultSummaryText(result)}`,
          },
        ],
        details: makeDetails([result]),
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: getResultSummaryText(result),
        },
      ],
      details: makeDetails([result]),
    };
  }

}
