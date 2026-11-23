import type {
  SignalEdgeSnapshot,
  SignalKind,
  SignalNodeSnapshot,
} from "../protocol/types.ts";

export const NODE_WIDTH = 212;
export const NODE_HEIGHT = 72;
export const LAYER_GAP = 88;
export const ROW_GAP = 22;
export const CANVAS_PADDING = 36;

export interface PositionedNode {
  readonly node: SignalNodeSnapshot;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RoutedEdge {
  readonly sourceId: number;
  readonly sinkId: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly path: string;
}

export interface GraphLayout {
  readonly nodes: ReadonlyArray<PositionedNode>;
  readonly edges: ReadonlyArray<RoutedEdge>;
  readonly nodeById: ReadonlyMap<number, PositionedNode>;
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
}

const KIND_ORDER: Record<SignalKind, number> = {
  state: 0,
  computed: 1,
  watcher: 2,
};

export function computeGraphLayout(
  nodes: ReadonlyArray<SignalNodeSnapshot>,
  edges: ReadonlyArray<SignalEdgeSnapshot>,
): GraphLayout {
  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      nodeById: new Map(),
      width: CANVAS_PADDING * 2,
      height: CANVAS_PADDING * 2,
      layerCount: 0,
    };
  }

  const nodeMap = new Map<number, SignalNodeSnapshot>();
  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number[]>();
  const inDegree = new Map<number, number>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  const validEdges: SignalEdgeSnapshot[] = [];
  for (const edge of edges) {
    if (edge.sourceId === edge.sinkId) continue;
    if (!nodeMap.has(edge.sourceId) || !nodeMap.has(edge.sinkId)) continue;
    validEdges.push(edge);
    outgoing.get(edge.sourceId)?.push(edge.sinkId);
    incoming.get(edge.sinkId)?.push(edge.sourceId);
    inDegree.set(edge.sinkId, (inDegree.get(edge.sinkId) ?? 0) + 1);
  }

  // Kahn's topological sort with longest-path layer assignment (cycle-safe)
  const layerById = new Map<number, number>();
  const queue: number[] = [];

  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
      layerById.set(node.id, 0);
    }
  }
  queue.sort((a, b) => compareNodes(nodeMap.get(a)!, nodeMap.get(b)!));

  const processed = new Set<number>();
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor++]!;
    processed.add(id);
    const currentLayer = layerById.get(id) ?? 0;

    for (const sinkId of outgoing.get(id) ?? []) {
      const nextLayer = Math.max(layerById.get(sinkId) ?? 0, currentLayer + 1);
      layerById.set(sinkId, nextLayer);
      const deg = (inDegree.get(sinkId) ?? 0) - 1;
      inDegree.set(sinkId, deg);
      if (deg === 0) {
        queue.push(sinkId);
      }
    }
  }

  // Cycle-breaking fallback for any nodes participating in a cycle
  if (processed.size < nodes.length) {
    const remaining = nodes
      .filter((n) => !processed.has(n.id))
      .toSorted(compareNodes);
    for (const node of remaining) {
      let maxIn = -1;
      for (const srcId of incoming.get(node.id) ?? []) {
        const srcLayer = layerById.get(srcId);
        if (srcLayer !== undefined && srcLayer > maxIn) {
          maxIn = srcLayer;
        }
      }
      layerById.set(node.id, maxIn + 1);
    }
  }

  // Align isolated Computeds on at least layer 1 and standalone Watchers on the terminal sink layer
  // whenever the graph has upstream signals, reducing Column 0 vertical stacking and edge spans.
  const hasNonWatcherSignals = nodes.some((n) => n.kind !== "watcher");
  const hasIncoming = (id: number) => (incoming.get(id)?.length ?? 0) > 0;
  let maxSignalLayer = 0;
  for (const node of nodes) {
    if (
      node.kind === "computed" &&
      !hasIncoming(node.id) &&
      nodes.some((n) => n.kind === "state")
    ) {
      layerById.set(node.id, Math.max(layerById.get(node.id) ?? 0, 1));
    }
    if (node.kind !== "watcher") {
      const l = layerById.get(node.id) ?? 0;
      if (l > maxSignalLayer) maxSignalLayer = l;
    }
  }
  if (hasNonWatcherSignals) {
    for (const node of nodes) {
      if (node.kind === "watcher" && !hasIncoming(node.id)) {
        layerById.set(
          node.id,
          Math.max(layerById.get(node.id) ?? 0, maxSignalLayer + 1),
        );
      }
    }
  }

  let maxLayer = 0;
  for (const layer of layerById.values()) {
    if (layer > maxLayer) maxLayer = layer;
  }

  const layers: SignalNodeSnapshot[][] = Array.from(
    { length: maxLayer + 1 },
    () => [],
  );
  for (const node of nodes) {
    const layer = layerById.get(node.id) ?? 0;
    layers[layer]?.push(node);
  }

  for (const layerNodes of layers) {
    layerNodes.sort(compareNodes);
  }

  // Two-pass barycenter crossing reduction (forward then backward)
  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < layers.length; l++) {
      const prevRowById = indexLayer(layers[l - 1]!);
      sortLayerByBarycenter(layers[l]!, incoming, prevRowById);
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      const nextRowById = indexLayer(layers[l + 1]!);
      sortLayerByBarycenter(layers[l]!, outgoing, nextRowById);
    }
  }

  let maxRows = 1;
  for (const layerNodes of layers) {
    if (layerNodes.length > maxRows) maxRows = layerNodes.length;
  }

  const maxColumnHeight =
    maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  const positionedNodes: PositionedNode[] = [];
  const positionedById = new Map<number, PositionedNode>();

  for (let l = 0; l < layers.length; l++) {
    const layerNodes = layers[l]!;
    const colHeight =
      layerNodes.length * NODE_HEIGHT +
      Math.max(0, layerNodes.length - 1) * ROW_GAP;
    const yOffset =
      CANVAS_PADDING + Math.round((maxColumnHeight - colHeight) / 2);
    const x = CANVAS_PADDING + l * (NODE_WIDTH + LAYER_GAP);

    for (let r = 0; r < layerNodes.length; r++) {
      const node = layerNodes[r]!;
      const y = yOffset + r * (NODE_HEIGHT + ROW_GAP);
      const positioned: PositionedNode = {
        node,
        layer: l,
        row: r,
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
      positionedNodes.push(positioned);
      positionedById.set(node.id, positioned);
    }
  }

  const routedEdges: RoutedEdge[] = validEdges.map((edge) => {
    const src = positionedById.get(edge.sourceId)!;
    const dst = positionedById.get(edge.sinkId)!;
    const x1 = src.x + src.width;
    const y1 = src.y + src.height / 2;
    const x2 = dst.x;
    const y2 = dst.y + dst.height / 2;
    const path = buildEdgePath(x1, y1, x2, y2);
    return {
      sourceId: edge.sourceId,
      sinkId: edge.sinkId,
      x1,
      y1,
      x2,
      y2,
      path,
    };
  });

  const width =
    CANVAS_PADDING * 2 +
    layers.length * NODE_WIDTH +
    Math.max(0, layers.length - 1) * LAYER_GAP;
  const height = CANVAS_PADDING * 2 + maxColumnHeight;

  return {
    nodes: positionedNodes,
    edges: routedEdges,
    nodeById: positionedById,
    width,
    height,
    layerCount: layers.length,
  };
}

function compareNodes(a: SignalNodeSnapshot, b: SignalNodeSnapshot): number {
  const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kindDiff !== 0) return kindDiff;
  return a.id - b.id;
}

function indexLayer(
  layerNodes: ReadonlyArray<SignalNodeSnapshot>,
): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < layerNodes.length; i++) {
    map.set(layerNodes[i]!.id, i);
  }
  return map;
}

function sortLayerByBarycenter(
  layerNodes: SignalNodeSnapshot[],
  adjacency: ReadonlyMap<number, ReadonlyArray<number>>,
  neighborIndices: ReadonlyMap<number, number>,
): void {
  const originalOrder = indexLayer(layerNodes);
  layerNodes.sort((a, b) => {
    const scoreA = computeBarycenter(
      a.id,
      adjacency,
      neighborIndices,
      originalOrder.get(a.id) ?? 0,
    );
    const scoreB = computeBarycenter(
      b.id,
      adjacency,
      neighborIndices,
      originalOrder.get(b.id) ?? 0,
    );
    if (scoreA !== scoreB) return scoreA - scoreB;
    return compareNodes(a, b);
  });
}

function computeBarycenter(
  nodeId: number,
  adjacency: ReadonlyMap<number, ReadonlyArray<number>>,
  neighborIndices: ReadonlyMap<number, number>,
  fallbackIndex: number,
): number {
  const neighbors = adjacency.get(nodeId) ?? [];
  let sum = 0;
  let count = 0;
  for (const neighborId of neighbors) {
    const idx = neighborIndices.get(neighborId);
    if (idx !== undefined) {
      sum += idx;
      count += 1;
    }
  }
  return count > 0 ? sum / count : fallbackIndex;
}

function buildEdgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x2 >= x1) {
    const dx = Math.max(36, (x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  // Back-edge arc above/below nodes in rare cycle cases
  const loopOffset = 56;
  const topY = Math.min(y1, y2) - loopOffset;
  return `M ${x1} ${y1} C ${x1 + 48} ${topY}, ${x2 - 48} ${topY}, ${x2} ${y2}`;
}
