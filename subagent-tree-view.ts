import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import {
  type ActivityStore,
  type FlatSubagentNode,
  type SubagentTreeNode,
  buildActivityTreeFromBranch,
  buildAgentDetailLines,
  buildSubagentTree,
  createActivityStore,
  flattenSubagentTree,
  getSubagentTreeSignature,
  preserveSelectionIndex,
  statusBadge,
  summarizeSubagentTree,
} from "./subagent-view-data.js";

type Theme = {
  fg: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

type Done = (value: void) => void;
type RequestRender = (force?: boolean) => void;

export interface SubagentViewerContext {
  hasUI: boolean;
  cwd: string;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getHeader">;
  ui?: Pick<ExtensionContext["ui"], "custom" | "notify">;
  activityStore?: Pick<ActivityStore, "getTree" | "getSignature" | "subscribe">;
}

type Mode = "tree" | "detail";

const BODY_HEIGHT = 24;
const TREE_FOOTER_LINES = 5;
const TREE_MAX_LINES = BODY_HEIGHT - TREE_FOOTER_LINES;
const REFRESH_INTERVAL_MS = 1000;
const DETAIL_BODY_LINES = BODY_HEIGHT - 2;

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

export interface VisibleSubagentTreeRow extends FlatSubagentNode {
  flatIndex: number;
  visibleParent: SubagentTreeNode | null;
  visibleDepth: number;
}

export function getVisibleSubagentTreeRows(flat: FlatSubagentNode[]): VisibleSubagentTreeRow[] {
  return flat.slice(1).map((row, flatIndex) => ({
    ...row,
    flatIndex: flatIndex + 1,
    visibleParent: row.parent && row.parent.kind !== "session" && row.parent.kind !== "root" ? row.parent : null,
    visibleDepth: Math.max(0, row.depth - 1),
  }));
}

export function getVisibleSubagentTreeSelectedVisibleIndex(flat: FlatSubagentNode[], selectedFlatIndex: number): number {
  return getVisibleSubagentTreeRows(flat).findIndex((row) => row.flatIndex === selectedFlatIndex);
}

export function getVisibleSubagentTreeFlatIndexFromVisibleIndex(flat: FlatSubagentNode[], visibleIndex: number): number {
  const rows = getVisibleSubagentTreeRows(flat);
  if (rows.length === 0) return 0;
  const clampedIndex = clamp(visibleIndex, 0, rows.length - 1);
  return rows[clampedIndex]?.flatIndex ?? rows[0]!.flatIndex;
}

export function normalizeVisibleSubagentSelection(flat: FlatSubagentNode[], selectedFlatIndex: number): number {
  const visibleIndex = getVisibleSubagentTreeSelectedVisibleIndex(flat, selectedFlatIndex);
  if (visibleIndex >= 0) return selectedFlatIndex;
  return getVisibleSubagentTreeFlatIndexFromVisibleIndex(flat, 0);
}

export function getVisibleSubagentTreeTurnGutterWidth(rows: VisibleSubagentTreeRow[]): number {
  let width = 1;
  for (const row of rows) {
    if (row.visibleDepth !== 0) continue;
    const index = row.node.turnIndex ?? row.node.orderKey ?? 0;
    width = Math.max(width, visibleWidth(`#${index}`));
  }
  return width;
}

export function getVisibleSubagentTreeLabel(row: VisibleSubagentTreeRow): string {
  if (row.node.kind === "active-agent-turn") {
    const activeAgentName = typeof row.node.activeAgentName === "string"
      ? row.node.activeAgentName.trim()
      : "";
    if (activeAgentName) return activeAgentName;

    const index = row.node.turnIndex ?? row.node.orderKey ?? 0;
    const prefix = row.node.recovered ? "Recovered turn" : "Turn";
    return `${prefix} #${index}`;
  }
  if (row.node.kind === "subagent" && row.node.toolName && row.node.label.startsWith(`${row.node.toolName} `)) {
    return row.node.label.slice(row.node.toolName.length + 1);
  }
  return row.node.label;
}

export function formatVisibleSubagentTreeRow(
  row: VisibleSubagentTreeRow,
  selected: boolean,
  turnGutterWidth: number,
): string {
  const selector = selected ? "› " : "  ";
  const turnIndex = row.node.turnIndex ?? row.node.orderKey ?? 0;
  const turnGutter = row.visibleDepth === 0
    ? `#${turnIndex}`.padStart(turnGutterWidth, " ")
    : " ".repeat(turnGutterWidth);
  const gutter = `${turnGutter} │ `;
  const branch = row.visibleDepth === 0
    ? ""
    : `${"│  ".repeat(Math.max(0, row.visibleDepth - 1))}${row.visibleParent && row.visibleParent.children[row.visibleParent.children.length - 1] === row.node ? "└─ " : "├─ "}`;
  return `${selector}${gutter}${branch}${getVisibleSubagentTreeLabel(row)} ${statusBadge(row.node.status)}`;
}

export function buildVisibleSubagentTreeRows(flat: FlatSubagentNode[], selectedIndex: number): string[] {
  const visibleRows = getVisibleSubagentTreeRows(flat);
  const turnGutterWidth = getVisibleSubagentTreeTurnGutterWidth(visibleRows);
  return visibleRows.map((row) => formatVisibleSubagentTreeRow(row, row.flatIndex === selectedIndex, turnGutterWidth));
}

export function preserveDetailScrollAfterRefresh(
  previousMode: Mode,
  previousSelectedNodeId: string | null,
  nextSelectedNode: SubagentTreeNode | undefined,
  previousDetailScroll: number,
): number {
  if (previousMode !== "detail") return 0;
  if (!nextSelectedNode || nextSelectedNode.kind === "session") return 0;
  if (nextSelectedNode.id !== previousSelectedNodeId) return 0;
  const wrappedDetailLength = buildAgentDetailLines(nextSelectedNode).length;
  const maxScroll = Math.max(0, wrappedDetailLength - DETAIL_BODY_LINES);
  return clamp(previousDetailScroll, 0, maxScroll);
}

class SubagentViewerComponent {
  private mode: Mode = "tree";
  private selected = 0;
  private detailScroll = 0;
  private root: SubagentTreeNode;
  private flat: FlatSubagentNode[];
  private readonly theme: Theme;
  private readonly requestRender: RequestRender;
  private readonly done: Done;
  private readonly getBranch: () => unknown[];
  private readonly activityStore?: Pick<ActivityStore, "getTree" | "getSignature" | "subscribe">;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private currentSignature = "";
  private disposed = false;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    getBranch: () => unknown[],
    theme: Theme,
    requestRender: RequestRender,
    done: Done,
    activityStore?: Pick<ActivityStore, "getTree" | "getSignature" | "subscribe">,
  ) {
    this.theme = theme;
    this.requestRender = requestRender;
    this.done = done;
    this.getBranch = getBranch;
    this.activityStore = activityStore;
    this.root = this.readTree();
    this.flat = flattenSubagentTree(this.root);
    this.selected = normalizeVisibleSubagentSelection(this.flat, this.flat.length > 1 ? 1 : 0);
    this.currentSignature = this.readSignature(this.root);
    if (this.activityStore) {
      this.unsubscribeStore = this.activityStore.subscribe(() => this.refreshFromStore());
    } else {
      this.startRefreshTimer();
    }
  }

  private startRefreshTimer(): void {
    this.refreshTimer = setInterval(() => {
      this.refreshFromBranch();
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer?.unref?.();
  }

  private readTree(): SubagentTreeNode {
    return this.activityStore ? this.activityStore.getTree() : buildActivityTreeFromBranch(this.getBranch());
  }

  private readSignature(root: SubagentTreeNode): string {
    return this.activityStore ? this.activityStore.getSignature() : getSubagentTreeSignature(root);
  }

  private refreshFromStore(): void {
    if (this.disposed) return;
    const nextRoot = this.readTree();
    const nextSignature = this.readSignature(nextRoot);
    if (nextSignature === this.currentSignature) return;

    const previousMode = this.mode;
    const previousSelectedId = this.flat[this.selected]?.node.id ?? null;
    const previousSelectedIndex = this.selected;
    const previousDetailScroll = this.detailScroll;

    this.root = nextRoot;
    this.flat = flattenSubagentTree(this.root);
    this.selected = normalizeVisibleSubagentSelection(
      this.flat,
      preserveSelectionIndex(this.flat, previousSelectedId, previousSelectedIndex),
    );
    this.currentSignature = nextSignature;
    this.detailScroll = preserveDetailScrollAfterRefresh(
      previousMode,
      previousSelectedId,
      this.flat[this.selected]?.node,
      previousDetailScroll,
    );
    this.invalidate();
    this.requestRender(true);
  }

  private refreshFromBranch(): void {
    if (this.disposed || this.activityStore) return;
    const nextRoot = this.readTree();
    const nextSignature = this.readSignature(nextRoot);
    if (nextSignature === this.currentSignature) return;

    const previousMode = this.mode;
    const previousSelectedId = this.flat[this.selected]?.node.id ?? null;
    const previousSelectedIndex = this.selected;
    const previousDetailScroll = this.detailScroll;

    this.root = nextRoot;
    this.flat = flattenSubagentTree(this.root);
    this.selected = normalizeVisibleSubagentSelection(
      this.flat,
      preserveSelectionIndex(this.flat, previousSelectedId, previousSelectedIndex),
    );
    this.currentSignature = nextSignature;
    this.detailScroll = preserveDetailScrollAfterRefresh(
      previousMode,
      previousSelectedId,
      this.flat[this.selected]?.node,
      previousDetailScroll,
    );
    this.invalidate();
    this.requestRender(true);
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

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
  }

  private handleTreeInput(data: string): void {
    if (data === "q" || data === "Q" || matchesKey(data, "escape")) {
      this.dispose();
      this.done(undefined);
      return;
    }
    const visibleRows = getVisibleSubagentTreeRows(this.flat);
    const currentVisibleIndex = getVisibleSubagentTreeSelectedVisibleIndex(this.flat, this.selected);
    const nextVisibleIndex = currentVisibleIndex >= 0 ? currentVisibleIndex : 0;
    if (matchesKey(data, "up")) {
      this.selected = getVisibleSubagentTreeFlatIndexFromVisibleIndex(this.flat, nextVisibleIndex - 1);
    } else if (matchesKey(data, "down")) {
      this.selected = getVisibleSubagentTreeFlatIndexFromVisibleIndex(this.flat, nextVisibleIndex + 1);
    } else if (matchesKey(data, "home")) {
      this.selected = getVisibleSubagentTreeFlatIndexFromVisibleIndex(this.flat, 0);
    } else if (matchesKey(data, "end")) {
      this.selected = getVisibleSubagentTreeFlatIndexFromVisibleIndex(this.flat, visibleRows.length - 1);
    } else if (matchesKey(data, "left")) {
      const parent = this.flat[this.selected]?.parent;
      if (parent) {
        const parentFlatIndex = this.flat.findIndex((row) => row.node === parent);
        const parentVisibleIndex = getVisibleSubagentTreeSelectedVisibleIndex(this.flat, parentFlatIndex);
        if (parentVisibleIndex >= 0) this.selected = getVisibleSubagentTreeFlatIndexFromVisibleIndex(this.flat, parentVisibleIndex);
      }
    } else if (matchesKey(data, "right")) {
      const node = this.flat[this.selected]?.node;
      if (node?.children[0]) {
        const childFlatIndex = this.flat.findIndex((row) => row.node === node.children[0]);
        const childVisibleIndex = getVisibleSubagentTreeSelectedVisibleIndex(this.flat, childFlatIndex);
        if (childVisibleIndex >= 0) this.selected = getVisibleSubagentTreeFlatIndexFromVisibleIndex(this.flat, childVisibleIndex);
      }
    } else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const node = this.flat[this.selected]?.node;
      if (node?.kind !== "session") {
        this.mode = "detail";
        this.detailScroll = 0;
      }
    }
  }

  private detailLines(): string[] {
    const node = this.flat[this.selected]?.node;
    if (!node) return ["No selection"];
    return buildAgentDetailLines(node);
  }

  private handleDetailInput(data: string): void {
    if (data === "q" || data === "Q") {
      this.dispose();
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
    const title = this.mode === "detail" ? "Node detail" : "Activity tree";
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
        this.theme.fg("muted", "No active-agent turns or subagents in the current session branch."),
        "",
        this.theme.fg("dim", "Trigger a new user message or run the subagent tool, then reopen this viewer."),
        "",
        this.theme.fg("dim", "q/Esc close"),
      ];
      while (empty.length < BODY_HEIGHT) empty.push("");
      return empty.map((line) => padLine(line, width));
    }

    const visibleRows = getVisibleSubagentTreeRows(this.flat);
    const selectedVisibleIndex = getVisibleSubagentTreeSelectedVisibleIndex(this.flat, this.selected);
    const safeSelectedVisibleIndex = selectedVisibleIndex >= 0 ? selectedVisibleIndex : 0;
    const start = clamp(safeSelectedVisibleIndex - Math.floor(TREE_MAX_LINES / 2), 0, Math.max(0, visibleRows.length - TREE_MAX_LINES));
    const end = Math.min(visibleRows.length, start + TREE_MAX_LINES);
    const visibleWindow = visibleRows.slice(start, end);
    const turnGutterWidth = getVisibleSubagentTreeTurnGutterWidth(visibleWindow);
    const rows: string[] = visibleWindow.map((row) => {
      const isSelected = row.flatIndex === this.selected;
      const text = formatVisibleSubagentTreeRow(row, isSelected, turnGutterWidth);
      return isSelected ? this.theme.fg("accent", text) : text;
    });
    while (rows.length < TREE_MAX_LINES) rows.push("");

    const selectedNode = this.flat[this.selected]?.node;
    const selectedResult = selectedNode?.result;
    const summary = summarizeSubagentTree(this.root);
    rows.push("");
    rows.push(
      this.theme.fg(
        "muted",
        `Selected: ${selectedNode ? `${selectedNode.label} ${statusBadge(selectedNode.status)}` : "none"}`,
      ),
    );
    rows.push(
      this.theme.fg(
        "dim",
        `Live: ${statusBadge(selectedNode?.status ?? "success")}  Running ${summary.running}/${summary.total} · Total ${summary.total}`,
      ),
    );
    rows.push(selectedResult?.task ? this.theme.fg("dim", `Task: ${selectedResult.task}`) : "");
    rows.push("");
    rows.push(this.theme.fg("dim", "↑↓ move  ← parent  → child  Enter open  q/Esc close"));
    return rows.map((line) => padLine(line, width));
  }

  private renderDetailBody(width: number): string[] {
    const raw = this.detailLines();
    const wrapped = wrapPlainLines(raw, width);
    const maxScroll = Math.max(0, wrapped.length - DETAIL_BODY_LINES);
    this.detailScroll = clamp(this.detailScroll, 0, maxScroll);
    const visible = wrapped.slice(this.detailScroll, this.detailScroll + DETAIL_BODY_LINES);
    while (visible.length < DETAIL_BODY_LINES) visible.push("");
    const node = this.flat[this.selected]?.node;
    visible.push("");
    visible.push(
      this.theme.fg(
        "dim",
        `Live: ${statusBadge(node?.status ?? "success")}  ${node ? node.label : "No selection"}`,
      ),
    );
    visible.push(this.theme.fg("dim", "↑↓/PgUp/PgDn scroll  Esc back  q close"));
    return visible.map((line) => padLine(line, width));
  }
}

export async function openSubagentViewer(ctx: SubagentViewerContext): Promise<void> {
  if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.custom !== "function") return;
  const getBranch = () => ctx.sessionManager.getBranch();
  await ctx.ui.custom<void>((tui: { requestRender: RequestRender }, theme: Theme, _keybindings: unknown, done: Done) => {
    const component = new SubagentViewerComponent(getBranch, theme, (force?: boolean) => tui.requestRender(force), done, ctx.activityStore);
    return component;
  }, {
    overlay: true,
    overlayOptions: {
      width: "100%",
      maxHeight: "100%",
      anchor: "center",
      margin: 0,
    },
  });
}
