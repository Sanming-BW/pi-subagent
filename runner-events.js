// @ts-check
/**
 * Helpers for parsing Pi JSON mode events and summarizing subagent results.
 *
 * @typedef {import("./types.js").SingleResult} SingleResult
 * @typedef {import("./types.js").SubagentDetails} SubagentDetails
 * @typedef {import("./types.js").UsageStats} UsageStats
 */

/** @returns {UsageStats} */
function createEmptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** @param {unknown} value */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function normalizeToolCallId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** @param {unknown} value */
function isValidNestedSingleResult(value) {
  if (!isPlainObject(value)) return false;
  if (typeof value.agent !== "string") return false;
  if (typeof value.task !== "string") return false;
  if (typeof value.exitCode !== "number") return false;
  if (!Array.isArray(value.messages)) return false;
  if (value.nestedDetails !== undefined) {
    if (!Array.isArray(value.nestedDetails)) return false;
    if (!value.nestedDetails.every(isValidNestedDetails)) return false;
  }
  return true;
}

/** @param {unknown} value */
function isValidNestedDetails(value) {
  if (!isPlainObject(value)) return false;
  if (value.mode !== "single") return false;
  if (value.delegationMode !== "spawn" && value.delegationMode !== "fork" && value.delegationMode !== "continue") return false;
  if (!Array.isArray(value.results)) return false;
  if (value.results.length > 1) return false;
  return value.results.every(isValidNestedSingleResult);
}

/** @param {unknown} value */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

/** @param {unknown} message */
function getMessageSignature(message) {
  return stableStringify(message);
}

/**
 * @param {SingleResult} result
 * @param {unknown} message
 * @returns {void}
 */
function updateAssistantMetadata(result, message) {
  if (!message || message.role !== "assistant") return;
  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

/**
 * @param {SingleResult} result
 * @param {unknown} message
 * @returns {boolean}
 */
function addAssistantMessage(result, message) {
  if (!message || message.role !== "assistant") return false;

  updateAssistantMetadata(result, message);

  const signature = getMessageSignature(message);
  const seen = getSeenMessageSignatures(result);
  if (seen.has(signature)) return false;
  seen.add(signature);

  result.messages.push(message);

  result.usage.turns++;
  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }

  return true;
}

/**
 * @param {SingleResult} result
 * @param {unknown} messages
 * @returns {boolean}
 */
function addAssistantMessages(result, messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addAssistantMessage(result, message)) changed = true;
  }
  return changed;
}

/**
 * @param {SingleResult & { __seenMessageSignatures?: Set<string> }} result
 * @returns {Set<string>}
 */
function getSeenMessageSignatures(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenMessageSignatures")) {
    Object.defineProperty(result, "__seenMessageSignatures", {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenMessageSignatures;
}

/**
 * @param {SingleResult & { __seenNestedKeys?: Set<string> }} result
 * @returns {Set<string>}
 */
function getSeenNestedKeys(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenNestedKeys")) {
    Object.defineProperty(result, "__seenNestedKeys", {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenNestedKeys;
}

/** @param {unknown} value */
function extractSubagentDetailsPayload(value) {
  if (isValidNestedDetails(value)) return value;
  if (isValidNestedSingleResult(value)) {
    return {
      mode: "single",
      delegationMode: "spawn",
      projectAgentsDir: null,
      results: [value],
    };
  }
  if (!isPlainObject(value)) return null;
  if (value.details !== undefined) {
    const nested = extractSubagentDetailsPayload(value.details);
    if (nested) return nested;
  }
  if (value.content !== undefined) {
    const nested = extractSubagentDetailsPayload(value.content);
    if (nested) return nested;
  }
  if (value.result !== undefined) {
    const nested = extractSubagentDetailsPayload(value.result);
    if (nested) return nested;
  }
  if (value.partialResult !== undefined) {
    const nested = extractSubagentDetailsPayload(value.partialResult);
    if (nested) return nested;
  }
  return null;
}

/** @param {unknown} event */
function createRunningSingleResult(event) {
  const args = isPlainObject(event?.args) ? event.args : {};
  const agent = typeof args.agent === "string" && args.agent.trim()
    ? args.agent.trim()
    : typeof event?.toolName === "string" && event.toolName.trim()
      ? event.toolName.trim()
      : "subagent";
  const task = typeof args.task === "string" ? args.task : "";
  return {
    agent,
    agentSource: "unknown",
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: createEmptyUsage(),
    toolCallId: normalizeToolCallId(event?.toolCallId),
  };
}

/** @param {SingleResult} result */
function findNestedDetailsEntry(result, toolCallId) {
  if (!toolCallId || !Array.isArray(result.nestedDetails)) return undefined;
  return result.nestedDetails.find((details) => {
    const nestedResult = details?.results?.[0];
    const key = normalizeToolCallId(nestedResult?.toolCallId)
      ?? normalizeToolCallId(nestedResult?.childLeafId)
      ?? normalizeToolCallId(nestedResult?.lineEvent?.lineId);
    return key === toolCallId;
  });
}

/**
 * @param {SingleResult} target
 * @param {unknown} patch
 * @returns {boolean}
 */
function mergeSingleResult(target, patch) {
  if (!patch || typeof patch !== "object") return false;
  let changed = false;

  if (typeof patch.agent === "string" && patch.agent.trim() && patch.agent.trim() !== target.agent) {
    target.agent = patch.agent.trim();
    changed = true;
  }
  if (patch.agentSource && patch.agentSource !== target.agentSource) {
    target.agentSource = patch.agentSource;
    changed = true;
  }
  if (typeof patch.task === "string" && patch.task !== target.task) {
    target.task = patch.task;
    changed = true;
  }
  if (typeof patch.exitCode === "number" && (patch.exitCode !== -1 || target.exitCode === -1) && patch.exitCode !== target.exitCode) {
    target.exitCode = patch.exitCode;
    changed = true;
  }
  if (Array.isArray(patch.messages) && addAssistantMessages(target, patch.messages)) changed = true;
  if (typeof patch.stderr === "string" && patch.stderr !== target.stderr) {
    target.stderr = patch.stderr;
    changed = true;
  }
  if (patch.usage && typeof patch.usage === "object") {
    const nextUsage = { ...target.usage, ...patch.usage };
    const usageChanged =
      nextUsage.input !== target.usage.input ||
      nextUsage.output !== target.usage.output ||
      nextUsage.cacheRead !== target.usage.cacheRead ||
      nextUsage.cacheWrite !== target.usage.cacheWrite ||
      nextUsage.cost !== target.usage.cost ||
      nextUsage.contextTokens !== target.usage.contextTokens ||
      nextUsage.turns !== target.usage.turns;
    if (usageChanged) {
      target.usage = nextUsage;
      changed = true;
    }
  }
  if (patch.model !== undefined && patch.model !== target.model) {
    target.model = patch.model;
    changed = true;
  }
  if (patch.stopReason !== undefined && patch.stopReason !== target.stopReason) {
    target.stopReason = patch.stopReason;
    changed = true;
  }
  if (patch.errorMessage !== undefined && patch.errorMessage !== target.errorMessage) {
    target.errorMessage = patch.errorMessage;
    changed = true;
  }
  if (patch.sawAgentEnd !== undefined && patch.sawAgentEnd !== target.sawAgentEnd) {
    target.sawAgentEnd = patch.sawAgentEnd;
    changed = true;
  }
  if (patch.childSessionId !== undefined && patch.childSessionId !== target.childSessionId) {
    target.childSessionId = patch.childSessionId;
    changed = true;
  }
  if (patch.childSessionFile !== undefined && patch.childSessionFile !== target.childSessionFile) {
    target.childSessionFile = patch.childSessionFile;
    changed = true;
  }
  if (patch.childLeafId !== undefined && patch.childLeafId !== target.childLeafId) {
    target.childLeafId = patch.childLeafId;
    changed = true;
  }
  if (patch.toolCallId !== undefined && patch.toolCallId !== target.toolCallId) {
    target.toolCallId = patch.toolCallId;
    changed = true;
  }
  if (patch.lineEvent !== undefined && patch.lineEvent !== target.lineEvent) {
    target.lineEvent = patch.lineEvent;
    changed = true;
  }
  if (patch.warning !== undefined && patch.warning !== target.warning) {
    target.warning = patch.warning;
    changed = true;
  }

  if (Array.isArray(patch.nestedDetails) && mergeNestedDetailsIntoResult(target, patch.nestedDetails)) {
    changed = true;
  }

  return changed;
}

/**
 * @param {SingleResult} result
 * @param {SubagentDetails[]} nestedDetails
 * @returns {boolean}
 */
function mergeNestedDetailsIntoResult(result, nestedDetails) {
  if (!Array.isArray(nestedDetails) || nestedDetails.length === 0) return false;
  if (!Array.isArray(result.nestedDetails)) result.nestedDetails = [];

  let changed = false;
  for (const incomingDetails of nestedDetails) {
    const patchDetails = extractSubagentDetailsPayload(incomingDetails);
    if (!patchDetails) continue;
    const patchResult = patchDetails.results[0];
    if (!patchResult) continue;

    const key = normalizeToolCallId(patchResult.toolCallId)
      ?? normalizeToolCallId(patchResult.childLeafId)
      ?? normalizeToolCallId(patchResult.lineEvent?.lineId);
    if (!key) continue;

    let liveDetails = findNestedDetailsEntry(result, key);
    if (!liveDetails) {
      liveDetails = {
        mode: "single",
        delegationMode: patchDetails.delegationMode,
        projectAgentsDir: patchDetails.projectAgentsDir,
        results: [createRunningSingleResult({ toolCallId: key, toolName: "subagent", args: { agent: patchResult.agent, task: patchResult.task } })],
      };
      result.nestedDetails.push(liveDetails);
      changed = true;
    } else {
      if (patchDetails.delegationMode && patchDetails.delegationMode !== liveDetails.delegationMode) {
        liveDetails.delegationMode = patchDetails.delegationMode;
        changed = true;
      }
      if (patchDetails.projectAgentsDir !== undefined && patchDetails.projectAgentsDir !== liveDetails.projectAgentsDir) {
        liveDetails.projectAgentsDir = patchDetails.projectAgentsDir;
        changed = true;
      }
    }

    const liveResult = liveDetails.results[0] ?? (liveDetails.results[0] = createRunningSingleResult({ toolCallId: key, toolName: "subagent", args: { agent: patchResult.agent, task: patchResult.task } }));
    liveResult.toolCallId = key;
    if (mergeSingleResult(liveResult, patchResult)) changed = true;
    if (Array.isArray(patchResult.nestedDetails) && mergeNestedDetailsIntoResult(liveResult, patchResult.nestedDetails)) changed = true;
  }

  return changed;
}

/**
 * @param {SingleResult} result
 * @param {unknown} event
 * @param {unknown} payload
 * @param {"start" | "update" | "end"} phase
 * @returns {boolean}
 */
function mergeToolExecutionNestedResult(result, event, payload, phase) {
  if (!event || event.toolName !== "subagent") return false;
  const toolCallId = normalizeToolCallId(event.toolCallId);
  if (!toolCallId) return false;

  const patchDetails = extractSubagentDetailsPayload(payload);
  let changed = false;
  let liveDetails = findNestedDetailsEntry(result, toolCallId);
  if (!liveDetails) {
    if (phase !== "start" && !patchDetails) return false;
    const args = isPlainObject(event.args) ? event.args : {};
    liveDetails = {
      mode: "single",
      delegationMode: patchDetails?.delegationMode
        ?? (typeof args.mode === "string" && (args.mode === "spawn" || args.mode === "fork" || args.mode === "continue") ? args.mode : "spawn"),
      projectAgentsDir: patchDetails?.projectAgentsDir ?? null,
      results: [createRunningSingleResult(event)],
    };
    if (!Array.isArray(result.nestedDetails)) result.nestedDetails = [];
    result.nestedDetails.push(liveDetails);
    changed = true;
  }

  const liveResult = liveDetails.results[0] ?? (liveDetails.results[0] = createRunningSingleResult(event));
  liveResult.toolCallId = toolCallId;
  if (phase === "start") {
    if (mergeSingleResult(liveResult, createRunningSingleResult(event))) changed = true;
  }

  if (patchDetails) {
    if (patchDetails.delegationMode && patchDetails.delegationMode !== liveDetails.delegationMode) {
      liveDetails.delegationMode = patchDetails.delegationMode;
      changed = true;
    }
    if (patchDetails.projectAgentsDir !== undefined && patchDetails.projectAgentsDir !== liveDetails.projectAgentsDir) {
      liveDetails.projectAgentsDir = patchDetails.projectAgentsDir;
      changed = true;
    }
    const patchResult = patchDetails.results[0];
    if (patchResult) {
      patchResult.toolCallId = patchResult.toolCallId ?? toolCallId;
      if (mergeSingleResult(liveResult, patchResult)) changed = true;
      if (Array.isArray(patchResult.nestedDetails) && mergeNestedDetailsIntoResult(liveResult, patchResult.nestedDetails)) changed = true;
    }
  }

  return changed;
}

/**
 * @param {SingleResult} result
 * @param {unknown} event
 * @returns {boolean}
 */
function appendNestedDetails(result, event) {
  return mergeToolExecutionNestedResult(result, event, event?.result, "end");
}

/**
 * Process a single Pi JSON event.
 *
 * @param {unknown} event
 * @param {SingleResult} result
 * @returns {boolean}
 */
export function processPiEvent(event, result) {
  if (!event || typeof event !== "object") return false;

  switch (event.type) {
    case "session":
      if (typeof event.id === "string") result.childSessionId = event.id;
      if (typeof event.sessionFile === "string") result.childSessionFile = event.sessionFile;
      if (typeof event.leafId === "string") result.childLeafId = event.leafId;
      return typeof event.id === "string";

    case "message_end":
      return addAssistantMessage(result, event.message);

    case "turn_end":
      return addAssistantMessage(result, event.message);

    case "agent_end":
      result.sawAgentEnd = true;
      return addAssistantMessages(result, event.messages);

    case "tool_execution_start":
      return mergeToolExecutionNestedResult(result, event, undefined, "start");

    case "tool_execution_update":
      return mergeToolExecutionNestedResult(result, event, event.partialResult, "update");

    case "tool_execution_end":
      return mergeToolExecutionNestedResult(result, event, event.result, "end");

    default:
      return false;
  }
}

/**
 * Parse and process one Pi JSON line.
 *
 * @param {string} line
 * @param {SingleResult} result
 * @returns {boolean}
 */
export function processPiJsonLine(line, result) {
  if (!line.trim()) return false;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  return processPiEvent(event, result);
}

/** @param {unknown[]} messages */
export function getFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        return part.text;
      }
    }
  }

  return "";
}

/**
 * Summarize a result with final text, stderr, or a fallback string.
 *
 * @param {Partial<SingleResult> & { messages?: unknown[] }} result
 * @returns {string}
 */
export function getResultSummaryText(result) {
  const finalText = getFinalAssistantText(result?.messages);
  if (finalText) return finalText;

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  const isError =
    (typeof result?.exitCode === "number" && result.exitCode > 0) ||
    result?.stopReason === "error" ||
    result?.stopReason === "aborted";

  if (isError && typeof result?.stderr === "string" && result.stderr.trim()) {
    return result.stderr.trim();
  }

  return "(no output)";
}
