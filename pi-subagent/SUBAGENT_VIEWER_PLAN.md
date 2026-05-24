# Subagent viewer implementation plan

## Goal

Add a dedicated subagent viewer so users can inspect previous subagent runs without relying on Pi's global tool-output expansion (`Ctrl+O`).

The viewer should:

- Open from a user-configurable shortcut.
- Also open from `/subagents`.
- Show a tree selector first.
- Let users move through the tree with arrow keys.
- Open the selected subagent detail with `Enter`.
- Let users scroll details and return to the tree with `Esc`.

Shortcut handling will not use Pi's native `registerShortcut()` API. It will use a plugin config file plus raw terminal input handling.

---

## Configuration

The plugin will add its own config files.

User config:

```text
~/.pi/agent/subagent.json
```

Project config:

```text
.pi/subagent.json
```

Project config overrides user config.

Default config:

```json
{
  "viewerKey": "ctrl+m"
}
```

Disable shortcut:

```json
{
  "viewerKey": "none"
}
```

Use another key:

```json
{
  "viewerKey": "ctrl+shift+o"
}
```

Priority:

```text
default < user config < project config
```

Changing config requires `/reload` or restarting Pi.

---

# V1

## Scope

V1 focuses on stable viewing of subagent results already recorded in the current parent session branch.

V1 supports:

- Config file loading.
- Configurable viewer shortcut.
- `/subagents` command.
- Tree selector.
- `Enter` to open details.
- Single subagent calls.
- Parallel subagent calls.
- Historical subagent tool results in the current branch.

V1 does not support:

- Full nested subagent recursion.
- Reading child session files recursively.
- Search/filter.
- Real-time updates while a subagent is running.
- Copy/export actions.
- Pi core changes.

## Data source

V1 reads from:

```ts
ctx.sessionManager.getBranch()
```

It scans branch entries for subagent tool results:

```ts
entry.type === "message"
entry.message.role === "toolResult"
entry.message.toolName === "subagent"
entry.message.details
```

The existing `SubagentDetails` is used:

```ts
interface SubagentDetails {
  mode: "single" | "parallel";
  delegationMode: DelegationMode;
  projectAgentsDir: string | null;
  results: SingleResult[];
}
```

## Tree structure

Single call:

```text
Session
└─ #1 worker ✓
```

Parallel call:

```text
Session
└─ #2 parallel ✓
   ├─ plan ✓
   ├─ worker ✓
   └─ tester ✗
```

Multiple calls:

```text
Session
├─ #1 worker ✓
├─ #2 parallel ✓
│  ├─ plan ✓
│  └─ worker ✗
└─ #3 oracle ⏳
```

## Tree selector UI

Example:

```text
╭─ Subagents ─────────────────────────────────────────────╮
│ Session                                                 │
│ ├─ #1 worker ✓                                          │
│ ├─ #2 parallel ✓                                        │
│ │  ├─ plan ✓                                            │
│ │  └─ worker ✗                                          │
│ └─ #3 oracle ⏳                                         │
│                                                         │
│ Selected: worker ✗                                      │
│ Task: Refactor render.ts and add tests                  │
│                                                         │
│ ↑↓ move  ← parent  → child  Enter open  q/Esc close      │
╰─────────────────────────────────────────────────────────╯
```

Tree keys:

| Key | Action |
| --- | --- |
| `↑` | Select previous visible node |
| `↓` | Select next visible node |
| `←` | Select parent node |
| `→` | Select first child node |
| `Home` | Select first visible node |
| `End` | Select last visible node |
| `Enter` | Open selected subagent detail |
| `Esc` | Close viewer |
| `q` | Close viewer |

## Detail UI

Example:

```text
╭─ Subagent detail ───────────────────────────────────────╮
│ worker ✗ [fork]                                         │
│ Source: project                                         │
│ Line: refactor-auth                                     │
│                                                         │
│ Task                                                    │
│ ─────────────────────────────────────────────────────── │
│ Refactor render.ts and add tests                        │
│                                                         │
│ Tool calls                                              │
│ ─────────────────────────────────────────────────────── │
│ → read render.ts                                        │
│ → edit render.ts                                        │
│ → bash npm test                                         │
│                                                         │
│ Output                                                  │
│ ─────────────────────────────────────────────────────── │
│ ...                                                     │
│                                                         │
│ ↑↓/PgUp/PgDn scroll  Esc back  q close                  │
╰─────────────────────────────────────────────────────────╯
```

Detail keys:

| Key | Action |
| --- | --- |
| `↑` | Scroll up |
| `↓` | Scroll down |
| `PageUp` | Scroll up by page |
| `PageDown` | Scroll down by page |
| `Home` | Jump to top |
| `End` | Jump to bottom |
| `Esc` | Return to tree selector |
| `q` | Close viewer |

## Detail content

A detail page should include:

- Agent name.
- Agent source: `user`, `project`, or `unknown`.
- Delegation mode: `spawn`, `fork`, or `continue`.
- Status.
- Stop reason.
- Error message.
- Stderr fallback.
- Line metadata.
- Warning.
- Task.
- Tool calls.
- Final assistant output.
- Usage.
- Model.

Existing helpers can be reused:

- `getDisplayItems(result.messages)`
- `getFinalOutput(result.messages)`
- `getResultSummaryText(result)`
- `isResultSuccess(result)`
- `isResultError(result)`
- `aggregateUsage(results)`

## Files

Add:

```text
config.ts
subagent-view-data.ts
subagent-tree-view.ts
test/subagent-view-data.test.mjs
```

Modify:

```text
index.ts
README.md
package.json
```

## Implementation notes

### `config.ts`

Responsibilities:

- Define config type.
- Define default config.
- Read user config.
- Find nearest project config by walking upward from `cwd`.
- Merge configs.
- Validate `viewerKey`.
- Warn and fall back safely on invalid config.

Suggested API:

```ts
export interface SubagentExtensionConfig {
  viewerKey: string;
}

export function loadSubagentConfig(cwd: string): SubagentExtensionConfig;
```

### `subagent-view-data.ts`

Responsibilities:

- Extract subagent tool results from branch entries.
- Build the tree.
- Flatten visible nodes for navigation.
- Compute node status.
- Build detail lines.

Suggested types:

```ts
export type SubagentNodeKind = "root" | "call" | "agent";
export type SubagentNodeStatus = "running" | "success" | "error" | "mixed";

export interface SubagentTreeNode {
  id: string;
  kind: SubagentNodeKind;
  label: string;
  status: SubagentNodeStatus;
  callIndex?: number;
  resultIndex?: number;
  mode?: "single" | "parallel";
  delegationMode?: DelegationMode;
  result?: SingleResult;
  children: SubagentTreeNode[];
}
```

### `subagent-tree-view.ts`

Responsibilities:

- Open overlay with `ctx.ui.custom()`.
- Render tree mode.
- Render detail mode.
- Handle keyboard input.
- Keep selection and scroll state.

Use overlay mode:

```ts
ctx.ui.custom(..., {
  overlay: true,
  overlayOptions: {
    width: "100%",
    maxHeight: "90%",
    anchor: "center",
    margin: 1
  }
});
```

### `index.ts`

Responsibilities:

- Load config on `session_start`.
- Install raw terminal input listener when UI is available.
- Do not use `pi.registerShortcut()`.
- Add guard to prevent multiple viewers from opening.
- Register `/subagents`.

Pseudo-code:

```ts
let viewerOpen = false;

pi.on("session_start", (_event, ctx) => {
  const config = loadSubagentConfig(ctx.cwd);
  if (!ctx.hasUI || config.viewerKey === "none") return;

  ctx.ui.onTerminalInput((data) => {
    if (viewerOpen) return undefined;
    if (!matchesKey(data, config.viewerKey as KeyId)) return undefined;

    viewerOpen = true;
    void openSubagentViewer(ctx).finally(() => {
      viewerOpen = false;
    });
    return { consume: true };
  });
});

pi.registerCommand("subagents", {
  description: "Open subagent viewer",
  handler: async (_args, ctx) => {
    if (viewerOpen) return;
    viewerOpen = true;
    try {
      await openSubagentViewer(ctx);
    } finally {
      viewerOpen = false;
    }
  },
});
```

## V1 acceptance criteria

- No config file means default shortcut is `ctrl+m`.
- User config can change the shortcut.
- Project config overrides user config.
- `viewerKey: "none"` disables the shortcut.
- `/subagents` always works in UI mode.
- Viewer lists all subagent tool results in the current branch.
- Single calls show as agent nodes.
- Parallel calls show as parent call nodes with child agent nodes.
- Arrow navigation works in the tree.
- `Enter` opens details.
- Detail scrolling works.
- `Esc` returns from detail to tree.
- `q` closes viewer.
- Existing subagent execution behavior is unchanged.
- `npm test` passes.

---

# V2

## Goal

V2 expands the viewer from a current-branch single-level/parallel viewer into a richer nested subagent explorer.

## Nested subagent support

Display nested subagent calls such as:

```text
Session
├─ worker ✓
│  └─ oracle ✓
│     └─ reviewer ✗
├─ parallel ✓
│  ├─ plan ✓
│  └─ worker ✓
│     └─ tester ✓
└─ oracle ⏳
```

## Capture nested subagent results

Enhance `runner-events.js` to process child Pi JSON events:

```ts
event.type === "tool_execution_end"
event.toolName === "subagent"
event.result.details
```

Store nested details on `SingleResult`:

```ts
interface SingleResult {
  nestedSubagents?: SubagentDetails[];
}
```

Then the tree builder can recursively expand `result.nestedSubagents`.

Pros:

- Fast.
- Does not need file I/O.
- Works well for newly-created sessions after the change.

Cons:

- Does not enrich old session data.

## Read child sessions recursively

Optionally read `childSessionFile` when available and scan it for subagent tool results.

Useful for:

- `fork` runs.
- `continue` runs.
- `spawn`/`fork` runs with `lineId`.

Limits:

- `spawn` without `lineId` may use `--no-session`, so there may be no child session file.
- Must enforce max depth and node limits.

Suggested defaults:

```json
{
  "viewerMaxDepth": 5,
  "viewerMaxNodes": 200
}
```

## V2 config extensions

Possible config:

```json
{
  "viewerKey": "ctrl+m",
  "viewerMaxDepth": 5,
  "viewerMaxNodes": 200,
  "viewerShowNested": true,
  "viewerDefaultMode": "tree"
}
```

Fields:

| Field | Meaning |
| --- | --- |
| `viewerKey` | Shortcut to open viewer |
| `viewerMaxDepth` | Max nested tree depth |
| `viewerMaxNodes` | Max nodes rendered/read |
| `viewerShowNested` | Whether nested subagents are shown |
| `viewerDefaultMode` | Initial viewer mode |

## Search and filter

Potential keys:

| Key | Action |
| --- | --- |
| `/` | Search agent/task/output summary |
| `n` | Next match |
| `N` | Previous match |
| `e` | Toggle error-only filter |
| `r` | Toggle running-only filter |
| `a` | Show all |

## Detail enhancements

Potential keys:

| Key | Action |
| --- | --- |
| `o` | Focus final output |
| `t` | Focus tool calls |
| `u` | Focus usage |
| `s` | Show child session metadata |
| `l` | Show line metadata |

## Real-time updates

Potential future enhancement:

- Track running subagent tool executions.
- Update viewer while it is open.
- Refresh tree and detail content on `tool_execution_update` / `tool_execution_end`.

This is intentionally not in V1 because it requires more state management and careful redraw behavior.

## V2 acceptance criteria

- Nested subagent calls are visible where data is available.
- Recursion is bounded by max depth and max node settings.
- Old sessions can be partially enriched from child session files when available.
- Search works on visible nodes.
- Filters work without losing current selection unexpectedly.
- Detail page can switch between output/tool calls/usage sections.
- V1 behavior remains stable.
