import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import {
  type FlatSubagentNode,
  type SubagentTreeNode,
  buildAgentDetailLines,
  buildCallDetailLines,
  buildSubagentTree,
  flattenSubagentTree,
  statusIcon,
} from "./subagent-view-data.js";

type Theme = {
  fg: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

type Done = (value: void) => void;
type RequestRender = (force?: boolean) => void;

type Mode = "tree" | "detail";

const BODY_HEIGHT = 24;
const TREE_FOOTER_LINES = 5;
const TREE_MAX_LINES = BODY_HEIGHT - TREE_FOOTER_LINES;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function padLine(text: string, width: number): string {
  const targetWidth = Math.max(0, width);
  const clipped = truncateToWidth(text, targetWidth, "…");
  const padding = Math.max(0, targetWidth - visibleWidth(clipped));
  return `${clipped}${" ".repeat(padding)}`;
}

function wrapPlainLines(lines: string[], width: number): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const wrapped = wrapTextWithAnsi(line || " ", Math.max(1, width));
    result.push(...(wrapped.length > 0 ? wrapped : [""]));
  }
  return result;
}

class SubagentViewerComponent {
  private mode: Mode = "tree";
  private selected = 0;
  private detailScroll = 0;
  private readonly root: SubagentTreeNode;
  private readonly flat: FlatSubagentNode[];
  private readonly theme: Theme;
  private readonly requestRender: RequestRender;
  private readonly done: Done;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    branch: unknown[],
    theme: Theme,
    requestRender: RequestRender,
    done: Done,
  ) {
    this.theme = theme;
    this.requestRender = requestRender;
    this.done = done;
    this.root = buildSubagentTree(branch);
    this.flat = flattenSubagentTree(this.root);
    this.selected = this.flat.length > 1 ? 1 : 0;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (this.mode === "detail") {
      this.handleDetailInput(data);
    } else {
      this.handleTreeInput(data);
    }
    this.invalidate();
    // Overlay repaint can leave stale rows behind when the underlying chat
    // history is taller than the viewport. Force a full TUI redraw for viewer
    // navigation so old selected rows are cleared instead of accumulating.
    this.requestRender(true);
  }

  private handleTreeInput(data: string): void {
    if (data === "q" || data === "Q" || matchesKey(data, "escape")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = clamp(this.selected - 1, 0, this.flat.length - 1);
    } else if (matchesKey(data, "down")) {
      this.selected = clamp(this.selected + 1, 0, this.flat.length - 1);
    } else if (matchesKey(data, "home")) {
      this.selected = 0;
    } else if (matchesKey(data, "end")) {
      this.selected = this.flat.length - 1;
    } else if (matchesKey(data, "left")) {
      const parent = this.flat[this.selected]?.parent;
      if (parent) this.selected = this.flat.findIndex((row) => row.node === parent);
    } else if (matchesKey(data, "right")) {
      const node = this.flat[this.selected]?.node;
      if (node?.children[0]) this.selected = this.flat.findIndex((row) => row.node === node.children[0]);
    } else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const node = this.flat[this.selected]?.node;
      if (node && (node.kind === "agent" || node.kind === "call")) {
        this.mode = "detail";
        this.detailScroll = 0;
      }
    }
  }

  private detailLines(): string[] {
    const node = this.flat[this.selected]?.node;
    if (!node) return ["No selection"];
    if (node.kind === "call") return buildCallDetailLines(node);
    return buildAgentDetailLines(node);
  }

  private handleDetailInput(data: string): void {
    if (data === "q" || data === "Q") {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.mode = "tree";
      this.detailScroll = 0;
      return;
    }

    const page = 12;
    const maxScroll = Math.max(0, this.detailLines().length - 1);
    if (matchesKey(data, "up")) this.detailScroll--;
    else if (matchesKey(data, "down")) this.detailScroll++;
    else if (matchesKey(data, Key.pageUp)) this.detailScroll -= page;
    else if (matchesKey(data, Key.pageDown)) this.detailScroll += page;
    else if (matchesKey(data, "home")) this.detailScroll = 0;
    else if (matchesKey(data, "end")) this.detailScroll = maxScroll;
    this.detailScroll = clamp(this.detailScroll, 0, maxScroll);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const contentWidth = Math.max(20, width - 4);
    const title = this.mode === "detail" ? "Subagent detail" : "Subagents";
    const lines: string[] = [];
    const titleLabel = `─ ${title} `;
    lines.push(this.theme.fg("accent", `╭${titleLabel}${"─".repeat(Math.max(0, contentWidth + 2 - visibleWidth(titleLabel)))}╮`));

    const body = this.mode === "detail" ? this.renderDetailBody(contentWidth) : this.renderTreeBody(contentWidth);
    for (const line of body) lines.push(`│ ${padLine(line, contentWidth)} │`);
    lines.push(this.theme.fg("accent", `╰${"─".repeat(contentWidth + 2)}╯`));

    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => padLine(truncateToWidth(line, width, ""), width));
    return this.cachedLines;
  }

  private renderTreeBody(width: number): string[] {
    if (this.root.children.length === 0) {
      const empty: string[] = [
        this.theme.fg("muted", "No subagent records in the current session branch."),
        "",
        this.theme.fg("dim", "Run the subagent tool, then open this viewer again."),
        "",
        this.theme.fg("dim", "q/Esc close"),
      ];
      while (empty.length < BODY_HEIGHT) empty.push("");
      return empty.map((line) => padLine(line, width));
    }

    const start = clamp(this.selected - Math.floor(TREE_MAX_LINES / 2), 0, Math.max(0, this.flat.length - TREE_MAX_LINES));
    const rows: string[] = this.flat.slice(start, start + TREE_MAX_LINES).map((row, visibleIndex) => {
      const index = start + visibleIndex;
      const isSelected = index === this.selected;
      const prefix = isSelected ? this.theme.fg("accent", "› ") : "  ";
      const branch = row.depth === 0 ? "" : `${"│  ".repeat(Math.max(0, row.depth - 1))}${this.isLastChild(row) ? "└─ " : "├─ "}`;
      const icon = row.node.displayState === "blocked" ? "" : ` ${statusIcon(row.node.status)}`;
      const text = `${prefix}${branch}${row.node.label}${icon}`;
      if (isSelected) return this.theme.fg("accent", text);
      if (row.node.displayState === "blocked") return this.theme.fg("dim", text);
      return text;
    });
    while (rows.length < TREE_MAX_LINES) rows.push("");

    const selectedNode = this.flat[this.selected]?.node;
    const selectedResult = selectedNode?.result;
    rows.push("");
    rows.push(this.theme.fg("muted", `Selected: ${selectedNode ? `${selectedNode.label}${selectedNode.displayState === "blocked" ? "" : ` ${statusIcon(selectedNode.status)}`}` : "none"}`));
    rows.push(selectedResult?.task ? this.theme.fg("dim", `Task: ${selectedResult.task}`) : "");
    rows.push("");
    rows.push(this.theme.fg("dim", "↑↓ move  ← parent  → child  Enter open  q/Esc close"));
    return rows.map((line) => padLine(line, width));
  }

  private isLastChild(row: FlatSubagentNode): boolean {
    if (!row.parent) return true;
    return row.parent.children[row.parent.children.length - 1] === row.node;
  }

  private renderDetailBody(width: number): string[] {
    const raw = this.detailLines();
    const wrapped = wrapPlainLines(raw, width);
    const maxScroll = Math.max(0, wrapped.length - BODY_HEIGHT + 2);
    this.detailScroll = clamp(this.detailScroll, 0, maxScroll);
    const visible = wrapped.slice(this.detailScroll, this.detailScroll + BODY_HEIGHT - 2);
    while (visible.length < BODY_HEIGHT - 2) visible.push("");
    visible.push("");
    visible.push(this.theme.fg("dim", "↑↓/PgUp/PgDn scroll  Esc back  q close"));
    return visible.map((line) => padLine(line, width));
  }
}

export async function openSubagentViewer(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.custom !== "function") return;
  const branch = ctx.sessionManager.getBranch();
  await ctx.ui.custom<void>((tui: { requestRender: RequestRender }, theme: Theme, _keybindings: unknown, done: Done) => {
    const component = new SubagentViewerComponent(branch, theme, (force?: boolean) => tui.requestRender(force), done);
    return component;
  }, {
    overlay: true,
    overlayOptions: {
      width: "100%",
      maxHeight: "90%",
      anchor: "center",
      margin: 1,
    },
  });
}
