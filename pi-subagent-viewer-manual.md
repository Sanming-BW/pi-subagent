# Pi Subagent Viewer Manual

This manual describes the current single-only subagent viewer.

## What the viewer shows

- recorded single subagent calls from the current session branch
- nested single subagent results as grandchildren
- a detail view for the selected agent node
- live status badges and selected-line summaries while the viewer stays open
- an empty state when there are no recorded subagent calls

## What the viewer no longer shows

- parallel call nodes
- `tasks[]` batch payloads
- any legacy parallel records are ignored by the viewer

> Historical note: the viewer is intentionally single-only.

## How to open it

Use the command:

```bash
/subagents
```

If you configured a shortcut key, that shortcut opens the same viewer.

## Basic workflow

1. Run a single subagent call.
2. Open `/subagents`.
3. Move through the tree with arrow keys.
4. Press `Enter` to open the detail view.
5. Press `Esc` to return to the tree.
6. Press `q` to close the viewer.
7. Keep the viewer open while the branch grows to see live updates.

## Validation checklist

- `pi -e .` starts normally.
- `/subagents` opens the viewer.
- single calls appear as agent nodes.
- nested single calls appear as grandchildren.
- legacy parallel records are ignored.
- running child runs show clearer status text and a live badge.
- `viewerKey` changes apply after `/reload` or restart.
- `viewerKey: "none"` disables the shortcut but keeps `/subagents` available.
- Jump links and search/filter remain future follow-up work.
