export function processPiEvent(event: unknown, result: import("./types.js").SingleResult): boolean;
export function processPiJsonLine(line: string, result: import("./types.js").SingleResult): boolean;
export function getFinalAssistantText(messages: unknown[]): string;
export function getResultSummaryText(result: Partial<import("./types.js").SingleResult> & { messages?: unknown[] }): string;
