export interface ResolveToolsSelectionResult {
	tools: string[] | undefined;
	warnings: string[];
}

function splitTopLevelCommaSeparated(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;

	for (const ch of input) {
		if (ch === "[") depth++;
		if (ch === "]" && depth > 0) depth--;

		if (ch === "," && depth === 0) {
			const token = current.trim();
			if (token) parts.push(token);
			current = "";
			continue;
		}

		current += ch;
	}

	const last = current.trim();
	if (last) parts.push(last);
	return parts;
}

function parseBracketList(token: string): string[] | null {
	const match = token.match(/^-\[(.*)\]$/s);
	if (!match) return null;
	const inner = match[1].trim();
	if (!inner) return [];
	return splitTopLevelCommaSeparated(inner)
		.map((s) => s.trim())
		.filter(Boolean);
}

function toTokens(rawTools: unknown, warnings: string[]): string[] | null {
	if (rawTools === undefined) return null;
	if (typeof rawTools === "string") {
		const trimmed = rawTools.trim();
		return trimmed ? splitTopLevelCommaSeparated(trimmed) : [];
	}
	if (Array.isArray(rawTools)) {
		const tokens: string[] = [];
		for (const item of rawTools) {
			if (typeof item !== "string") {
				warnings.push("Invalid tools array item. Expected strings only");
				continue;
			}
			const trimmed = item.trim();
			if (trimmed) tokens.push(trimmed);
		}
		return tokens;
	}
	warnings.push("Invalid tools field. Expected a comma-separated string or string array");
	return null;
}

export function resolveToolsSelection(
	rawTools: unknown,
	availableTools: string[],
): ResolveToolsSelectionResult {
	const warnings: string[] = [];
	const tokens = toTokens(rawTools, warnings);
	if (tokens === null) {
		return { tools: undefined, warnings };
	}

	const allTools = Array.from(new Set(availableTools.filter(Boolean)));
	const selected = new Set<string>();
	const excluded = new Set<string>();
	let sawPositive = false;
	let sawWildcard = false;

	for (const token of tokens) {
		if (token === "*") {
			sawWildcard = true;
			for (const tool of allTools) selected.add(tool);
			continue;
		}

		if (token.startsWith("-")) {
			const bracketList = parseBracketList(token);
			if (token.startsWith("-[") && bracketList === null) {
				warnings.push(`Invalid exclude-list syntax "${token}"`);
				continue;
			}
			const items = bracketList ?? [token.slice(1).trim()];
			for (const item of items) {
				if (!item) continue;
				excluded.add(item);
				selected.delete(item);
			}
			continue;
		}

		sawPositive = true;
		if (allTools.includes(token)) {
			selected.add(token);
		} else {
			warnings.push(`Unknown tool "${token}"`);
		}
	}

	if (!sawPositive && !sawWildcard && excluded.size > 0) {
		for (const tool of allTools) selected.add(tool);
	}

	for (const tool of excluded) selected.delete(tool);

	const resolved = Array.from(selected);
	return { tools: resolved, warnings };
}
