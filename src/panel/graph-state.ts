import type {
  GraphSnapshot,
  SignalEdgeSnapshot,
  SignalEvent,
  SignalKind,
  SignalNodeSnapshot,
} from "../protocol/types.ts";
import { computeGraphLayout, type GraphLayout } from "./graph-layout.ts";

export type KindFilter = "all" | SignalKind;
export type LivenessFilter = "all" | "live" | "cold";
export type EventTypeFilter = "all" | SignalEvent["type"];

export interface PanelFilterState {
  readonly query: string;
  readonly kindFilter: KindFilter;
  readonly livenessFilter: LivenessFilter;
  readonly onlyErrored: boolean;
  readonly eventTypeFilter: EventTypeFilter;
  readonly followSelectionInTimeline: boolean;
}

export interface PanelViewModel {
  readonly snapshot: GraphSnapshot | null;
  readonly layout: GraphLayout;
  readonly visibleNodes: ReadonlyArray<SignalNodeSnapshot>;
  readonly visibleEdges: ReadonlyArray<SignalEdgeSnapshot>;
  readonly visibleNodeIds: ReadonlySet<number>;
  readonly selectedNode: SignalNodeSnapshot | null;
  readonly upstreamIds: ReadonlySet<number>;
  readonly downstreamIds: ReadonlySet<number>;
  readonly directSourceIds: ReadonlySet<number>;
  readonly directSinkIds: ReadonlySet<number>;
  readonly directCauseIds: ReadonlySet<number>;
  readonly filteredEvents: ReadonlyArray<SignalEvent>;
  readonly stats: {
    readonly totalNodes: number;
    readonly stateCount: number;
    readonly computedCount: number;
    readonly watcherCount: number;
    readonly liveCount: number;
    readonly erroredCount: number;
    readonly edgeCount: number;
  };
}

export const DEFAULT_FILTER_STATE: PanelFilterState = {
  query: "",
  kindFilter: "all",
  livenessFilter: "all",
  onlyErrored: false,
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

export function nodeMatchesFilter(
  node: SignalNodeSnapshot,
  filter: PanelFilterState,
): boolean {
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

  const q = filter.query.trim().toLowerCase();
  if (!q) return true;

  if (`#${node.id}`.includes(q)) return true;
  if (node.label?.toLowerCase().includes(q)) return true;
  if (node.kind.includes(q)) return true;
  if (node.runtime.toLowerCase().includes(q)) return true;
  if (node.value?.text.toLowerCase().includes(q)) return true;
  if (node.error?.toLowerCase().includes(q)) return true;
  if (node.site?.file.toLowerCase().includes(q)) return true;
  return false;
}

export function formatNodeDisplayName(node: SignalNodeSnapshot): string {
  if (node.label) return node.label;
  if (node.site?.fn) return `${node.kind} · ${node.site.fn}`;
  return `${node.kind} #${node.id}`;
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
      selectedNode: null,
      upstreamIds: new Set(),
      downstreamIds: new Set(),
      directSourceIds: new Set(),
      directSinkIds: new Set(),
      directCauseIds: new Set(),
      filteredEvents: [],
      stats: {
        totalNodes: 0,
        stateCount: 0,
        computedCount: 0,
        watcherCount: 0,
        liveCount: 0,
        erroredCount: 0,
        edgeCount: 0,
      },
    };
  }

  let stateCount = 0;
  let computedCount = 0;
  let watcherCount = 0;
  let liveCount = 0;
  let erroredCount = 0;

  const nodeById = new Map<number, SignalNodeSnapshot>();
  for (const node of snapshot.nodes) {
    nodeById.set(node.id, node);
    if (node.kind === "state") stateCount++;
    else if (node.kind === "computed") computedCount++;
    else watcherCount++;
    if (node.live) liveCount++;
    if (node.error !== null) erroredCount++;
  }

  const visibleNodes = snapshot.nodes.filter((node) =>
    nodeMatchesFilter(node, filter),
  );
  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const visibleEdges = snapshot.edges.filter(
    (edge) =>
      visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.sinkId),
  );

  const layout = computeGraphLayout(visibleNodes, visibleEdges);

  const selectedNode =
    selectedNodeId !== null ? (nodeById.get(selectedNodeId) ?? null) : null;

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
    selectedNode,
    upstreamIds,
    downstreamIds,
    directSourceIds,
    directSinkIds,
    directCauseIds,
    filteredEvents,
    stats: {
      totalNodes: snapshot.nodes.length,
      stateCount,
      computedCount,
      watcherCount,
      liveCount,
      erroredCount,
      edgeCount: snapshot.edges.length,
    },
  };
}
