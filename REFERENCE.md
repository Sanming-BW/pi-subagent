# REFERENCE — Blocked parallel rendering

This document defines the display rule for parallel subagent calls that never launched any workers.

## Terminology

- **Parallel call**: a subagent tool result with `details.mode === "parallel"`.
- **Blocked call**: a parallel call whose `details.results.length === 0`.
- **Normal parallel call**: a parallel call with one or more results.

## Display rule

Render blocked calls as:

- label: `blocked`
- color: muted gray / dim
- icon: none
- tree behavior: selectable, but not expandable

Do not render blocked calls as `parallel` in the tree.

## Why this exists

A blocked call usually means the tool was stopped before workers started, often because of a front-door validation or policy check. The tree should not suggest that a real parallel fan-out happened.

## What stays visible

Keep these fields available in the detail view:

- `resultText` — the recorded reason or error text
- `isError` — whether the tool result is marked as error
- `delegationMode` — `spawn`, `fork`, or `continue`
- `projectAgentsDir` — if available
- raw call metadata already stored in the session branch

## What should not change

- Raw session data format
- Successful parallel call rendering
- Single-call rendering
- Tool result storage
- Session tree recording logic

## Suggested detail text

Use a simple detail layout:

```text
blocked [spawn]

This call produced no agents.

Reason
──────
<recorded reason text>
```

If `isError` is true, the section title may be `Error` instead of `Reason`.

## Acceptance criteria

- A zero-result parallel call is shown as `blocked`.
- It is dimmed in the tree.
- It can still be selected and opened.
- The detail view shows the recorded reason.
- Normal parallel calls remain unchanged.
