import type {
  GraphSnapshot,
  RuntimeMode,
  SignalEdgeSnapshot,
  SignalEvent,
  SignalKind,
  SignalNodeSnapshot,
} from "../protocol/types.ts";
import {
  matchGlob,
  parseQuery,
  type ParsedQuery,
  type QueryToken,
} from "../shared/query-parser.ts";
import { computeGraphLayout, type GraphLayout } from "./graph-layout.ts";

export type KindFilter = "all" | SignalKind;
export type LivenessFilter = "all" | "live" | "cold";
export type EventTypeFilter = "all" | SignalEvent["type"];
export type QueryMode = "highlight" | "filter";

export interface PanelFilterState {
  readonly query: string;
  readonly queryMode: QueryMode;
  readonly kindFilter: KindFilter;
  readonly livenessFilter: LivenessFilter;
  readonly onlyErrored: boolean;
  readonly showInternal: boolean;
  readonly focusSubgraphNodeId: number | null;
  readonly eventTypeFilter: EventTypeFilter;
  readonly followSelectionInTimeline: boolean;
}

export interface RuntimeInventoryEntry {
  readonly name: string;
  readonly mode: RuntimeMode;
  readonly count: number;
  readonly excluded: boolean;
  readonly included: boolean;
}

export interface PanelViewModel {
  readonly snapshot: GraphSnapshot | null;
  readonly layout: GraphLayout;
  readonly visibleNodes: ReadonlyArray<SignalNodeSnapshot>;
  readonly visibleEdges: ReadonlyArray<SignalEdgeSnapshot>;
  readonly visibleNodeIds: ReadonlySet<number>;
  readonly focusedNode: SignalNodeSnapshot | null;
  readonly selectedNode: SignalNodeSnapshot | null;
  readonly upstreamIds: ReadonlySet<number>;
  readonly downstreamIds: ReadonlySet<number>;
  readonly directSourceIds: ReadonlySet<number>;
  readonly directSinkIds: ReadonlySet<number>;
  readonly directCauseIds: ReadonlySet<number>;
  readonly queryMode: QueryMode;
  readonly isHighlightQueryActive: boolean;
  readonly searchMatchIds: ReadonlySet<number>;
  readonly orderedMatchIds: ReadonlyArray<number>;
  readonly runtimeInventory: ReadonlyArray<RuntimeInventoryEntry>;
  readonly filteredEvents: ReadonlyArray<SignalEvent>;
  readonly stats: {
    readonly totalNodes: number;
    readonly stateCount: number;
    readonly computedCount: number;
    readonly watcherCount: number;
    readonly liveCount: number;
    readonly erroredCount: number;
    readonly internalCount: number;
    readonly edgeCount: number;
  };
}

export const DEFAULT_FILTER_STATE: PanelFilterState = {
  query: "",
  queryMode: "highlight",
  kindFilter: "all",
  livenessFilter: "all",
  onlyErrored: false,
  showInternal: false,
  focusSubgraphNodeId: null,
  eventTypeFilter: "all",
  followSelectionInTimeline: false,
};

export function collectReachableIds(
  startId: number,
  adjacency: ReadonlyMap<number, ReadonlyArray<number>>,
): ReadonlySet<number> {
  const visited = new Set<number>();
  const stack = [...(adjacency.get(startId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === startId || visited.has(id)) continue;
    visited.add(id);
    for (const nextId of adjacency.get(id) ?? []) {
      if (!visited.has(nextId)) {
        stack.push(nextId);
      }
    }
  }
  return visited;
}

function queryExplicitlyAllowsInternal(
  node: SignalNodeSnapshot,
  parsedQuery: ParsedQuery,
): boolean {
  return parsedQuery.inclusions.some(
    (token) =>
      (token.field === "is" && token.value.toLowerCase() === "internal") ||
      (token.field === "id" &&
        /^\d+$/.test(token.value) &&
        Number(token.value) === node.id),
  );
}

export function nodeMatchesToken(
  node: SignalNodeSnapshot,
  token: QueryToken,
): boolean {
  if (token.value.length === 0) return true;

  switch (token.field) {
    case "id":
      return /^\d+$/.test(token.value) && node.id === Number(token.value);
    case "kind":
      return matchGlob(token.value, node.kind);
    case "runtime":
      return matchGlob(token.value, node.runtime);
    case "file": {
      if (node.site === null) return false;
      if (token.value.includes("*")) {
        return matchGlob(token.value, node.site.file);
      }
      return node.site.file.toLowerCase().includes(token.value.toLowerCase());
    }
    case "is": {
      switch (token.value.toLowerCase()) {
        case "live":
          return node.live;
        case "cold":
          return !node.live;
        case "error":
        case "errors":
        case "errored":
          return node.error !== null;
        case "unread":
          return node.unread;
        case "internal":
          return node.internal === true;
        default:
          return false;
      }
    }
    case "text": {
      const needle = token.value.toLowerCase();
      if (`#${node.id}`.includes(needle)) return true;
      if (node.label?.toLowerCase().includes(needle)) return true;
      if (node.autoLabel?.toLowerCase().includes(needle)) return true;
      if (node.ownerLabel?.toLowerCase().includes(needle)) return true;
      if (node.computeSource?.toLowerCase().includes(needle)) return true;
      if (node.computeSignature?.toLowerCase().includes(needle)) return true;
      if (node.value?.text.toLowerCase().includes(needle)) return true;
      if (node.error?.toLowerCase().includes(needle)) return true;
      if (node.site?.file.toLowerCase().includes(needle)) return true;
      if (node.site?.fn?.toLowerCase().includes(needle)) return true;
      if (node.kind.toLowerCase().includes(needle)) return true;
      if (node.runtime.toLowerCase().includes(needle)) return true;
      return false;
    }
    default:
      return false;
  }
}

function nodeMatchesBaseStructural(
  node: SignalNodeSnapshot,
  filter: PanelFilterState,
  subgraphIds: ReadonlySet<number> | null,
  parsedQuery: ParsedQuery,
): boolean {
  if (
    node.internal === true &&
    !filter.showInternal &&
    !queryExplicitlyAllowsInternal(node, parsedQuery)
  ) {
    return false;
  }
  if (subgraphIds !== null && !subgraphIds.has(node.id)) {
    return false;
  }
  if (filter.kindFilter !== "all" && node.kind !== filter.kindFilter) {
    return false;
  }
  if (filter.livenessFilter === "live" && !node.live) {
    return false;
  }
  if (filter.livenessFilter === "cold" && node.live) {
    return false;
  }
  if (filter.onlyErrored && node.error === null) {
    return false;
  }
  return true;
}

export function nodeMatchesFilter(
  node: SignalNodeSnapshot,
  filter: PanelFilterState,
  subgraphIds: ReadonlySet<number> | null = null,
  parsedQuery: ParsedQuery = parseQuery(filter.query),
): boolean {
  if (!nodeMatchesBaseStructural(node, filter, subgraphIds, parsedQuery)) {
    return false;
  }
  if (parsedQuery.exclusions.some((token) => nodeMatchesToken(node, token))) {
    return false;
  }
  if (filter.queryMode === "filter" && parsedQuery.inclusions.length > 0) {
    return parsedQuery.inclusions.every((token) =>
      nodeMatchesToken(node, token),
    );
  }
  return true;
}

function cleanSiteFnName(rawFn: string | null | undefined): string | null {
  if (!rawFn) return null;
  const cleaned = rawFn
    .trim()
    .replace(/^new\s+/, "")
    .replace(/\.<instance_members_initializer>/g, "")
    .replace(/<instance_members_initializer>/g, "")
    .replace(/^Object\./, "")
    .trim();
  if (cleaned.length === 0 || cleaned === "<anonymous>") {
    return null;
  }
  return cleaned;
}

export function formatNodeDisplayName(node: SignalNodeSnapshot): string {
  const label = node.label?.trim();
  if (label) return label;
  const autoLabel = node.autoLabel?.trim();
  if (autoLabel) return autoLabel;
  const siteFn = cleanSiteFnName(node.site?.fn);
  if (siteFn) return siteFn;
  return `${node.kind} #${node.id}`;
}

function buildRuntimeInventory(
  nodes: ReadonlyArray<SignalNodeSnapshot>,
  parsedQuery: ParsedQuery,
): ReadonlyArray<RuntimeInventoryEntry> {
  const counts = new Map<string, { mode: RuntimeMode; count: number }>();
  for (const node of nodes) {
    const existing = counts.get(node.runtime);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(node.runtime, { mode: node.runtimeMode, count: 1 });
    }
  }

  const excludedRuntimes: string[] = [];
  const excludedSeen = new Set<string>();
  for (const token of parsedQuery.exclusions) {
    if (token.field !== "runtime") continue;
    const key = token.value.toLowerCase();
    if (!excludedSeen.has(key)) {
      excludedSeen.add(key);
      excludedRuntimes.push(token.value);
    }
  }

  const includedRuntimes: string[] = [];
  const includedSeen = new Set<string>();
  for (const token of parsedQuery.inclusions) {
    if (token.field !== "runtime") continue;
    const key = token.value.toLowerCase();
    if (!includedSeen.has(key)) {
      includedSeen.add(key);
      includedRuntimes.push(token.value);
    }
  }

  const entries: RuntimeInventoryEntry[] = [];
  for (const [name, info] of counts.entries()) {
    entries.push({
      name,
      mode: info.mode,
      count: info.count,
      excluded: excludedRuntimes.some((pattern) => matchGlob(pattern, name)),
      included: includedRuntimes.some((pattern) => matchGlob(pattern, name)),
    });
  }

  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return entries;
}

export function derivePanelViewModel(
  snapshot: GraphSnapshot | null,
  filter: PanelFilterState,
  selectedNodeId: number | null,
): PanelViewModel {
  if (!snapshot) {
    return {
      snapshot: null,
      layout: computeGraphLayout([], []),
      visibleNodes: [],
      visibleEdges: [],
      visibleNodeIds: new Set(),
      focusedNode: null,
      selectedNode: null,
      upstreamIds: new Set(),
      downstreamIds: new Set(),
      directSourceIds: new Set(),
      directSinkIds: new Set(),
      directCauseIds: new Set(),
      queryMode: filter.queryMode,
      isHighlightQueryActive: false,
      searchMatchIds: new Set(),
      orderedMatchIds: [],
      runtimeInventory: [],
      filteredEvents: [],
      stats: {
        totalNodes: 0,
        stateCount: 0,
        computedCount: 0,
        watcherCount: 0,
        liveCount: 0,
        erroredCount: 0,
        internalCount: 0,
        edgeCount: 0,
      },
    };
  }

  let stateCount = 0;
  let computedCount = 0;
  let watcherCount = 0;
  let liveCount = 0;
  let erroredCount = 0;
  let internalCount = 0;

  const nodeById = new Map<number, SignalNodeSnapshot>();
  for (const node of snapshot.nodes) {
    nodeById.set(node.id, node);
    if (node.kind === "state") stateCount++;
    else if (node.kind === "computed") computedCount++;
    else watcherCount++;
    if (node.live) liveCount++;
    if (node.error !== null) erroredCount++;
    if (node.internal === true) internalCount++;
  }

  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number[]>();
  for (const edge of snapshot.edges) {
    const outList = outgoing.get(edge.sourceId);
    if (outList) outList.push(edge.sinkId);
    else outgoing.set(edge.sourceId, [edge.sinkId]);

    const inList = incoming.get(edge.sinkId);
    if (inList) inList.push(edge.sourceId);
    else incoming.set(edge.sinkId, [edge.sourceId]);
  }

  const focusedNode =
    filter.focusSubgraphNodeId !== null
      ? (nodeById.get(filter.focusSubgraphNodeId) ?? null)
      : null;

  let subgraphIds: Set<number> | null = null;
  if (focusedNode) {
    const up = collectReachableIds(focusedNode.id, incoming);
    const down = collectReachableIds(focusedNode.id, outgoing);
    subgraphIds = new Set<number>([focusedNode.id, ...up, ...down]);
  }

  const parsedQuery = parseQuery(filter.query);
  const runtimeInventory = buildRuntimeInventory(snapshot.nodes, parsedQuery);

  const structurallyVisibleNodes = snapshot.nodes.filter(
    (node) =>
      nodeMatchesBaseStructural(node, filter, subgraphIds, parsedQuery) &&
      !parsedQuery.exclusions.some((token) => nodeMatchesToken(node, token)),
  );

  const hasPositiveInclusions = parsedQuery.inclusions.length > 0;
  const isHighlightQueryActive =
    filter.queryMode === "highlight" && hasPositiveInclusions;

  const matchingNodes = hasPositiveInclusions
    ? structurallyVisibleNodes.filter((node) =>
        parsedQuery.inclusions.every((token) => nodeMatchesToken(node, token)),
      )
    : [];
  const searchMatchIds = new Set(matchingNodes.map((n) => n.id));

  const visibleNodes =
    filter.queryMode === "filter" && hasPositiveInclusions
      ? matchingNodes
      : structurallyVisibleNodes;

  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const visibleEdges = snapshot.edges.filter(
    (edge) =>
      visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.sinkId),
  );

  const layout = computeGraphLayout(visibleNodes, visibleEdges);

  const orderedMatchIds = Array.from(searchMatchIds).toSorted((a, b) => {
    const posA = layout.nodeById.get(a);
    const posB = layout.nodeById.get(b);
    if (!posA && !posB) return a - b;
    if (!posA) return 1;
    if (!posB) return -1;
    if (posA.layer !== posB.layer) return posA.layer - posB.layer;
    if (posA.row !== posB.row) return posA.row - posB.row;
    return posA.node.id - posB.node.id;
  });

  const selectedNode =
    selectedNodeId !== null ? (nodeById.get(selectedNodeId) ?? null) : null;

  const upstreamIds = selectedNode
    ? collectReachableIds(selectedNode.id, incoming)
    : new Set<number>();
  const downstreamIds = selectedNode
    ? collectReachableIds(selectedNode.id, outgoing)
    : new Set<number>();
  const directSourceIds = new Set(
    selectedNode ? (incoming.get(selectedNode.id) ?? []) : [],
  );
  const directSinkIds = new Set(
    selectedNode ? (outgoing.get(selectedNode.id) ?? []) : [],
  );
  const directCauseIds = new Set(selectedNode ? selectedNode.causes : []);

  const filteredEvents = snapshot.events
    .filter((event) => {
      if (
        filter.eventTypeFilter !== "all" &&
        event.type !== filter.eventTypeFilter
      ) {
        return false;
      }
      if (filter.followSelectionInTimeline && selectedNode) {
        return (
          event.nodeId === selectedNode.id || directCauseIds.has(event.nodeId)
        );
      }
      return true;
    })
    .toReversed();

  return {
    snapshot,
    layout,
    visibleNodes,
    visibleEdges,
    visibleNodeIds,
    focusedNode,
    selectedNode,
    upstreamIds,
    downstreamIds,
    directSourceIds,
    directSinkIds,
    directCauseIds,
    queryMode: filter.queryMode,
    isHighlightQueryActive,
    searchMatchIds,
    orderedMatchIds,
    runtimeInventory,
    filteredEvents,
    stats: {
      totalNodes: snapshot.nodes.length,
      stateCount,
      computedCount,
      watcherCount,
      liveCount,
      erroredCount,
      internalCount,
      edgeCount: snapshot.edges.length,
    },
  };
}
