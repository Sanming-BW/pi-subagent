// @ts-check
/**
 * Helpers for parsing Pi JSON mode events and summarizing subagent results.
 *
 * @typedef {import("./types.js").SingleResult} SingleResult
 * @typedef {import("./types.js").SubagentDetails} SubagentDetails
 * @typedef {import("./types.js").UsageStats} UsageStats
 */

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
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

/**
 * @param {SingleResult} result
 * @param {unknown} event
 * @returns {boolean}
 */
function appendNestedDetails(result, event) {
  if (!event || event.toolName !== "subagent") return false;
  const details = event.result?.details;
  if (!isValidNestedDetails(details)) return false;

  const seen = getSeenNestedKeys(result);
  const key = typeof event.toolCallId === "string" && event.toolCallId
    ? `id:${event.toolCallId}`
    : `sig:${stableStringify(details)}`;
  if (seen.has(key)) return false;
  seen.add(key);

  if (!Array.isArray(result.nestedDetails)) result.nestedDetails = [];
  result.nestedDetails.push(details);
  return true;
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

    case "tool_execution_end":
      return appendNestedDetails(result, event);

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
