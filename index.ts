/**
 * Pi Subagent Extension
 *
 * Delegates tasks to specialized subagents, each running as an isolated `pi`
 * process.
 *
 * Supports two invocation shapes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *
 * Context modes:
 *   - spawn (default): child gets only the task prompt.
 *   - fork: child gets a forked snapshot of current session context + task prompt.
 *   - continue: resume a single-mode lineId checkpoint.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";
import { loadSubagentConfig } from "./config.js";
import { buildForkSessionSnapshotJsonl, type SessionSnapshotSource } from "./fork-snapshot.js";
import { findVisibleLine, formatAvailableLines } from "./line-history.js";
import { renderCall, renderResult } from "./render.js";
import { openSubagentViewer } from "./subagent-tree-view.js";
import { materializeCheckpointSnapshot, needsCopyOnWrite } from "./session-checkpoint.js";
import { getResultSummaryText } from "./runner-events.js";
import { withLineLock } from "./line-lock.js";
import { mapConcurrent, runAgent } from "./runner.js";
import { getWorktreeFingerprint, hasWorktreeDrift, WORKTREE_DRIFT_TASK_PREFIX } from "./worktree-fingerprint.js";
import { matchesKey } from "@mariozechner/pi-tui";
import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  DEFAULT_DELEGATION_MODE,
  emptyUsage,
  isResultError,
  isResultSuccess,
} from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PARALLEL_HEARTBEAT_MS = 1000;
const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
  agent: Type.String({
    description: "Name of an available agent (must match exactly)",
  }),
  task: Type.String({
    description:
      "Task description for this delegated run. In spawn mode include all required context; in fork mode the subagent also sees your current session context.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for this agent's process" }),
  ),
});

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
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description:
        "For parallel mode: array of {agent, task} objects. Each task runs in an isolated process concurrently. Do NOT set agent/task when using this.",
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
  return (mode: "single" | "parallel") =>
    (results: SingleResult[]): SubagentDetails => ({
      mode,
      delegationMode,
      projectAgentsDir,
      results,
    });
}

function formatAgentNames(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
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

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let viewerOpen = false;

  async function guardedOpenSubagentViewer(ctx: { hasUI?: boolean; ui?: { notify?: (message: string, level?: string) => void }; sessionManager: SessionSnapshotSource; cwd: string }): Promise<void> {
    if (!ctx.hasUI) return;
    if (viewerOpen) return;
    viewerOpen = true;
    try {
      await openSubagentViewer(ctx as any);
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
  pi.registerFlag("subagent-prevent-cycles", {
    description:
      "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });

  const depthConfig = resolveDelegationDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;

  let discoveredAgents: AgentConfig[] = [];

  pi.registerCommand("subagents", {
    description: "Open subagent viewer",
    handler: async (_args, ctx) => {
      await guardedOpenSubagentViewer(ctx as any);
    },
  });

  // Auto-discover agents on session start
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      const config = loadSubagentConfig(ctx.cwd);
      const ui = ctx.ui as typeof ctx.ui & {
        onTerminalInput?: (handler: (data: string) => { consume: boolean } | undefined) => void;
      };
      if (config.viewerKey !== "none" && typeof ui.onTerminalInput === "function") {
        const viewerKey = config.viewerKey;
        ui.onTerminalInput((data: string) => {
          if (viewerOpen) return undefined;
          if (!matchesKey(data, viewerKey)) return undefined;
          void guardedOpenSubagentViewer(ctx as any);
          return { consume: true };
        });
      }
    }

    if (!canDelegate) return;

    const discovery = discoverAgents(ctx.cwd, "both", getAllToolNames(pi));
    discoveredAgents = discovery.agents;

    if (discoveredAgents.length > 0 && ctx.hasUI) {
      const list = discoveredAgents
        .map((a) => `  - ${a.name} (${a.source})`)
        .join("\n");
      ctx.ui.notify(
        `Found ${discoveredAgents.length} subagent(s):\n${list}`,
        "info",
      );
    }
  });

  // Inject available agents into the system prompt
  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    if (discoveredAgents.length === 0) return;

    const agentList = discoveredAgents
      .map((a) => `- **${a.name}**: ${a.description}`)
      .join("\n");
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

### How to call the subagent tool

Each subagent runs in an **isolated process**.

Context behavior is controlled by optional 'mode':
- 'spawn' (default): child receives only the provided task prompt.
- 'fork': child receives a forked snapshot of current session context plus the task prompt.
- 'continue': resume a previous single-mode checkpoint by agent + lineId.

**Single mode** — delegate one task:
\`\`\`json
{ "agent": "agent-name", "task": "Detailed task...", "mode": "spawn" }
\`\`\`

**Reusable line** — choose your own lineId on spawn/fork if you may continue later:
\`\`\`json
{ "agent": "agent-name", "mode": "spawn", "lineId": "short-stable-name", "task": "Start work..." }
{ "agent": "agent-name", "mode": "continue", "lineId": "short-stable-name", "task": "Continue work..." }
\`\`\`

**Parallel mode** — run multiple tasks concurrently (do NOT also set agent/task):
\`\`\`json
{ "tasks": [{ "agent": "agent-name", "task": "..." }, { "agent": "other-agent", "task": "..." }], "mode": "fork" }
\`\`\`

Use single mode for one task, parallel mode when tasks are independent. lineId is caller-chosen, not generated automatically, and top-level lineId is single-mode only.

### Runtime delegation guards

- Max depth: current depth ${currentDepth}, max depth ${maxDepth}
- Cycle prevention: ${preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${ancestorAgentStack.length > 0 ? ancestorAgentStack.join(" -> ") : "(root)"}
`,
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
        "  Single mode:   set `agent` and `task` (both required together).",
        "  Parallel mode: set `tasks` array (do NOT also set `agent`/`task`).",
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
        'Example parallel: { tasks: [{ agent: "writer", task: "..." }, { agent: "tester", task: "..." }], mode: "fork" }',
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
                text: `Invalid mode \"${String(params.mode)}\". Expected \"spawn\", \"fork\", or \"continue\".\nAvailable agents: ${formatAgentNames(agents)}`,
              },
            ],
            details: fallbackDetails("single")([]),
            isError: true,
          };
        }

        const makeDetails = makeDetailsFactory(
          discovery.projectAgentsDir,
          delegationMode,
        );

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
              details: makeDetails("single")([]),
              isError: true,
            };
          }
        }

        // Validate: exactly one invocation shape must be specified
        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        if (Number(hasTasks) + Number(hasSingle) !== 1) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid parameters. Provide exactly one invocation shape.\nAvailable agents: ${formatAgentNames(agents)}`,
              },
            ],
            details: makeDetails("single")([]),
          };
        }

        if (delegationMode === "continue") {
          if (!params.lineId || !params.lineId.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Invalid parameters: mode=\"continue\" requires lineId. No default line is selected automatically.",
                },
              ],
              details: makeDetails(hasTasks ? "parallel" : "single")([]),
              isError: true,
            };
          }
          if (hasTasks) {
            return {
              content: [
                {
                  type: "text",
                  text: "Invalid parameters: mode=\"continue\" currently supports single mode only. Provide agent, task, and lineId.",
                },
              ],
              details: makeDetails("parallel")([]),
              isError: true,
            };
          }
        } else if (hasTasks && params.lineId) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid parameters: top-level lineId is only supported for single mode. Parallel line checkpoints are not implemented yet.",
              },
            ],
            details: makeDetails("parallel")([]),
            isError: true,
          };
        }

        const requested = new Set<string>();
        if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
        if (params.agent) requested.add(params.agent);

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
              details: makeDetails(hasTasks ? "parallel" : "single")([]),
              isError: true,
            };
          }
        }

        // ── Parallel mode ──
        if (params.tasks && params.tasks.length > 0) {
          return executeParallel(
            params.tasks,
            delegationMode,
            forkSessionSnapshotJsonl,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
          );
        }

        // ── Single mode ──
        if (params.agent && params.task) {
          let continueSessionFile: string | undefined;
          let continuedFrom: { childSessionId: string; childSessionFile?: string; childLeafId?: string } | undefined;
          let warning: string | undefined;
          let copyOnWrite = false;
          let effectiveTask = params.task;
          const effectiveCwd = params.cwd ?? ctx.cwd;
          const worktree = getWorktreeFingerprint(effectiveCwd);
          if (delegationMode === "continue") {
            const lineId = params.lineId!.trim();
            const visibleLine = findVisibleLine(ctx.sessionManager.getBranch(), params.agent, lineId);
            if (!visibleLine) {
              const available = formatAvailableLines(ctx.sessionManager.getBranch(), params.agent);
              return {
                content: [
                  {
                    type: "text",
                    text: `No line "${lineId}" for agent "${params.agent}" in current branch, or it is outside the latest 3 visible lines.\n\nAvailable lines for this agent in the current branch:\n${available}`,
                  },
                ],
                details: makeDetails("single")([]),
                isError: true,
              };
            }
            if (!visibleLine.event.childSessionFile) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Cannot continue line "${lineId}" for agent "${params.agent}": the checkpoint is missing childSessionFile. Re-open this line with spawn/fork and lineId to create a resumable checkpoint.`,
                  },
                ],
                details: makeDetails("single")([]),
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
            params.agent!,
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
          const lockKey = `${parentSessionId}:${params.agent}:${lineId}`;
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
              details: makeDetails("single")([]),
              isError: true,
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Available agents: ${formatAgentNames(agents)}`,
            },
          ],
          details: makeDetails("single")([]),
        };
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
    makeDetails: ReturnType<typeof makeDetailsFactory>,
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
      makeDetails: makeDetails("single"),
    });

    if (isResultError(result)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${result.stopReason || "failed"}: ${getResultSummaryText(result)}`,
          },
        ],
        details: makeDetails("single")([result]),
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
      details: makeDetails("single")([result]),
    };
  }

  async function executeParallel(
    tasks: Array<{ agent: string; task: string; cwd?: string }>,
    delegationMode: DelegationMode,
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    if (tasks.length > MAX_PARALLEL_TASKS) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
          },
        ],
        details: makeDetails("parallel")([]),
      };
    }

    // Initialize placeholder results for streaming
    const allResults: SingleResult[] = tasks.map((t) => ({
      agent: t.agent,
      agentSource: "unknown" as const,
      task: t.task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
    }));

    const emitProgress = () => {
      if (!onUpdate) return;
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      onUpdate({
        content: [
          {
            type: "text",
            text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
          },
        ],
        details: makeDetails("parallel")([...allResults]),
      });
    };

    let heartbeat: NodeJS.Timeout | undefined;
    if (onUpdate) {
      emitProgress();
      heartbeat = setInterval(() => {
        if (allResults.some((r) => r.exitCode === -1)) emitProgress();
      }, PARALLEL_HEARTBEAT_MS);
    }

    let results: SingleResult[];
    try {
      results = await mapConcurrent(
        tasks,
        MAX_CONCURRENCY,
        async (t, index) => {
          const result = await runAgent({
            cwd: defaultCwd,
            agents,
            agentName: t.agent,
            task: t.task,
            taskCwd: t.cwd,
            delegationMode,
            forkSessionSnapshotJsonl,
            parentDepth: currentDepth,
            parentAgentStack: ancestorAgentStack,
            maxDepth,
            preventCycles,
            signal,
            onUpdate: (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitProgress();
              }
            },
            makeDetails: makeDetails("parallel"),
          });
          allResults[index] = result;
          emitProgress();
          return result;
        },
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const successCount = results.filter((r) => isResultSuccess(r)).length;
    const summaries = results.map((r) =>
      `[${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r)}`,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
        },
      ],
      details: makeDetails("parallel")(results),
    };
  }
}
