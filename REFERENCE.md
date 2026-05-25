# REFERENCE — Active agent prompt override

This document defines the intended behavior for changing main-session active-agent prompt handling in the Pi subagent extension.

## Problem

The extension currently supports a main-session **active agent**. Selecting an active agent can change:

- model
- thinking level
- active tools
- system prompt instructions

However, the active-agent prompt is currently appended after Pi's default coding-agent system prompt. That means a specialized agent such as `plan` still receives Pi's generic coding-assistant persona first, then receives the active-agent persona later.

Current effective shape:

```text
You are an expert coding assistant operating inside pi...
Available tools...
Guidelines...
Project context...
Skills...
Current date/cwd...

Available Subagents...

Active Agent: plan
You are a planning assistant...
```

This can dilute the active agent's role. For example, a planning agent whose prompt says "do not modify code" is preceded by Pi's default prompt saying the assistant can edit and write files.

## Goal

When an active agent is selected, the active agent's prompt should become the primary system prompt.

Target effective shape:

```text
Active Agent: plan
You are a planning assistant...

Available tools...
Guidelines...
Available Subagents...
Project context...
Skills...
Current date/cwd...
```

The active-agent prompt should replace Pi's generic coding-agent persona, while preserving the operational context required to use Pi correctly.

## API basis

Pi extensions can modify or replace the system prompt in the `before_agent_start` event:

```ts
pi.on("before_agent_start", async (event, ctx) => {
  return {
    systemPrompt: "replacement prompt for this turn",
  };
});
```

Important event fields:

```ts
event.systemPrompt
```

The fully assembled prompt Pi would normally send, including changes from earlier `before_agent_start` handlers.

```ts
event.systemPromptOptions
```

Structured inputs used by Pi to build the prompt. This is the preferred source for rebuilding selected prompt sections.

Relevant `systemPromptOptions` fields:

- `customPrompt?: string`
- `selectedTools?: string[]`
- `toolSnippets?: Record<string, string>`
- `promptGuidelines?: string[]`
- `appendSystemPrompt?: string`
- `cwd: string`
- `contextFiles?: Array<{ path: string; content: string }>`
- `skills?: Skill[]`

## Core behavior

### No active agent

If no active agent is selected, behavior should remain unchanged.

The extension may keep appending its subagent information to `event.systemPrompt` as it does today.

### Active agent selected

If `activeAgentState.activeAgent` is set, the extension should return a replacement prompt.

The replacement prompt should:

- start with the active-agent identity and `agent.systemPrompt`
- not include Pi's default coding-agent persona from `event.systemPrompt`
- preserve useful runtime context from `event.systemPromptOptions`
- include available subagent information when the `subagent` tool is active
- preserve project instructions and skills
- end with current date and current working directory

## Recommended prompt order

Use this order in active-agent override mode.

### 1. Active agent section

Example:

```markdown
# Active Agent: plan

You are a planning assistant. Your goal is to understand the codebase, analyze requirements, and create clear implementation plans. You do not modify code.
```

The body is the markdown body of the selected agent file.

### 2. User/system additions

If Pi loaded a custom system prompt or appended system prompt, preserve it as additional instructions.

Suggested shape:

```markdown
## Additional System Prompt

<systemPromptOptions.customPrompt>
```

```markdown
## Appended System Prompt

<systemPromptOptions.appendSystemPrompt>
```

Rationale: active-agent override should not silently drop explicit user configuration, but these additions should not precede the active-agent identity.

### 3. Available tools

Use `systemPromptOptions.selectedTools` and `systemPromptOptions.toolSnippets`.

Suggested shape:

```markdown
## Available tools

- read: Read file contents
- grep: Search file contents
- subagent: Delegate work to specialized subagents
```

Rules:

- Only include active selected tools.
- Only include tools that have a snippet.
- If no selected active tool has a snippet, show `(none)`.
- Do not infer tool availability from all registered tools.

### 4. Guidelines

Preserve the useful default Pi guidance while avoiding the generic coding persona.

Recommended guideline logic:

- If `bash` is active and none of `grep`, `find`, or `ls` is active:
  - `Use bash for file operations like ls, rg, find`
- If `bash` and any of `grep`, `find`, or `ls` are active:
  - `Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)`
- Include non-empty `systemPromptOptions.promptGuidelines`.
- Include:
  - `Be concise in your responses`
  - `Show file paths clearly when working with files`

Deduplicate exact repeated guidelines while preserving first occurrence.

### 5. Available subagents

The extension currently injects a custom `Available Subagents` section because the `subagent` tool needs more usage guidance than a one-line tool snippet.

In active-agent override mode, include this section when:

- visible agents exist, and
- the `subagent` tool is active, or `selectedTools` is absent/unknown

The section should include:

- visible subagent list
- exact `subagent` invocation shapes
- `spawn`, `fork`, and `continue` mode explanation
- `lineId` explanation
- parallel invocation notes
- runtime delegation guard status

Hidden agents remain excluded from this discovery-oriented list.

### 6. Project context

Preserve `systemPromptOptions.contextFiles`.

A stable wrapper format is recommended:

```xml
<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/path/to/AGENTS.md">
...
</project_instructions>

</project_context>
```

This mirrors newer Pi prompt style and keeps file paths explicit.

### 7. Skills

Preserve loaded skills from `systemPromptOptions.skills`.

Rules:

- Include skills only when `read` is active.
- Prefer using Pi's `formatSkillsForPrompt(skills)` export.
- If compatibility requires a local fallback, keep the same basic meaning: expose skill name, description, and instruction to read `SKILL.md` when relevant.

Rationale: Pi's skills are progressive-disclosure. The prompt should advertise available skills, but full skill content should still be loaded with `read` only when needed.

### 8. Current date and cwd

End with:

```text
Current date: YYYY-MM-DD
Current working directory: /path/to/cwd
```

Use the same date format and cwd normalization as Pi's prompt builder.

## Relationship to active tools

Active-agent frontmatter may define tools:

```yaml
tools: read,bash,grep,find,ls
```

The existing `applyActiveAgent()` behavior already calls:

```ts
pi.setActiveTools(agent.tools)
```

This should remain unchanged.

Prompt generation should describe the currently selected tools from `systemPromptOptions.selectedTools`; it should not independently apply or change tools.

## Relationship to model and thinking

Active-agent frontmatter may define:

```yaml
model: openai/gpt-5.2
thinking: high
```

Existing model and thinking behavior should remain unchanged.

The prompt override should not change:

- `resolveModelReference()`
- `pi.setModel()` calls
- `pi.setThinkingLevel()` calls
- baseline restore behavior

## Relationship to `customPrompt`

Pi's `customPrompt` normally replaces Pi's default prompt while still appending project context, skills, date, and cwd.

In active-agent override mode, the active agent is the primary persona. Therefore:

- `agent.systemPrompt` should come first.
- `customPrompt` should be preserved as additional system instructions after the agent prompt.
- `customPrompt` should not replace the active-agent prompt.

This avoids surprising users who explicitly selected an active agent.

## Relationship to `appendSystemPrompt`

`appendSystemPrompt` should be preserved after the active-agent prompt, before operational context.

It should not be duplicated.

## Relationship to other extensions

`before_agent_start` handlers are chained. `event.systemPrompt` reflects modifications from earlier handlers.

This feature intentionally rebuilds from `systemPromptOptions` when active agent is selected. That means it may discard earlier extensions' string-only modifications if those modifications only changed `event.systemPrompt` and did not alter structured options.

Recommended policy for this repository:

- Accept this limitation for now.
- Document that active-agent override mode prioritizes the active agent prompt and Pi's structured prompt context.
- If preserving arbitrary earlier extension modifications becomes important, add an opt-in compatibility mode later.

## Implementation sketch

```ts
import type { BuildSystemPromptOptions } from "@mariozechner/pi-coding-agent";
import { formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";

function buildActiveAgentSystemPrompt(input: {
  agent: AgentConfig;
  visibleAgents: AgentConfig[];
  systemPromptOptions: BuildSystemPromptOptions;
}): string {
  const { agent, visibleAgents, systemPromptOptions } = input;

  const sections = [
    buildActiveAgentSection(agent),
    buildUserPromptAdditions(systemPromptOptions),
    buildToolsSection(systemPromptOptions),
    buildGuidelinesSection(systemPromptOptions),
    buildAvailableSubagentsSection(visibleAgents, systemPromptOptions),
    buildProjectContextSection(systemPromptOptions),
    buildSkillsSection(systemPromptOptions),
    buildDateCwdSection(systemPromptOptions.cwd),
  ];

  return sections.filter(Boolean).join("\n\n");
}
```

Then in the existing handler:

```ts
pi.on("before_agent_start", async (event) => {
  if (!canDelegate) return;

  const visibleAgents = getVisibleDiscoveredAgents();

  if (activeAgentState.activeAgent) {
    return {
      systemPrompt: buildActiveAgentSystemPrompt({
        agent: activeAgentState.activeAgent,
        visibleAgents,
        systemPromptOptions: event.systemPromptOptions,
      }),
    };
  }

  // Existing append behavior when no active agent.
});
```

## Acceptance criteria

A correct implementation satisfies all of the following:

- When no active agent is selected, current prompt behavior is unchanged.
- When an active agent is selected, the returned system prompt starts with the active-agent section.
- The active-agent replacement prompt does not include Pi's default coding-agent persona from `event.systemPrompt`.
- The active-agent replacement prompt includes selected tool descriptions.
- The active-agent replacement prompt includes default and configured guidelines.
- The active-agent replacement prompt includes available subagent instructions when `subagent` is active.
- The active-agent replacement prompt includes project context files.
- The active-agent replacement prompt includes skills when `read` is active.
- The active-agent replacement prompt omits skills when `read` is inactive.
- The active-agent replacement prompt includes current date and cwd.
- Existing model/thinking/tool activation behavior is unchanged.
- Existing `/agent` command behavior is unchanged.
- Existing `defaultAgent` config behavior is unchanged.

## Test scenarios

### No active agent

Given:

- discovered visible agent `plan`
- no active agent
- `event.systemPrompt = "BASE PROMPT"`

Expect:

- returned prompt starts with `BASE PROMPT`
- returned prompt includes `Available Subagents`

### Active agent override

Given:

- active agent `plan`
- `event.systemPrompt = "BASE PROMPT SHOULD NOT APPEAR"`
- `plan.systemPrompt = "You are a planning assistant."`

Expect:

- returned prompt starts with active-agent heading
- returned prompt includes `You are a planning assistant.`
- returned prompt does not include `BASE PROMPT SHOULD NOT APPEAR`

### Tools

Given:

```ts
selectedTools: ["read", "grep", "subagent"]
toolSnippets: {
  read: "Read file contents",
  grep: "Search file contents",
  write: "Write files",
  subagent: "Delegate work",
}
```

Expect:

- `read`, `grep`, and `subagent` appear
- `write` does not appear

### Skills

Given skills exist and `read` is active:

- skill list appears

Given skills exist and `read` is inactive:

- skill list is omitted

### Hidden agents

Given visible agent `plan` and hidden agent `oracle`:

- prompt-level subagent list includes `plan`
- prompt-level subagent list excludes `oracle`

## Manual verification

Run:

```bash
pi -e . --agent plan
```

Ask a simple planning request.

Expected behavior:

- model follows the plan agent role first
- prompt no longer emphasizes Pi's generic coding persona before the plan agent
- available tools and skills still work normally

Run:

```bash
pi -e .
```

without an active/default agent.

Expected behavior:

- prompt behavior remains append-based as before
- subagent tool instructions still appear

## Non-goals

This feature should not change:

- agent discovery precedence
- active-agent config parsing
- default-agent startup selection
- hidden-agent visibility rules
- active tool application
- model selection
- thinking-level selection
- child subagent process execution
- subagent invocation schema
