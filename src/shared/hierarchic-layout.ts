export interface LayoutNodeInput {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly sortGroup?: number;
  readonly minLayerHint?: number;
  readonly ownerGroupId?: number | null;
  readonly anchorToOwner?: boolean;
  readonly ownerOrder?: number;
}

export interface LayoutEdgeInput {
  readonly id: string;
  readonly sourceId: number;
  readonly targetId: number;
  readonly priority?: number;
  readonly isFeedbackHint?: boolean;
  readonly busGroupKey?: string | null;
  readonly labelWidth?: number;
  readonly labelHeight?: number;
  readonly weight?: number;
  readonly minSpan?: number;
}

export interface HierarchicLayoutOptions {
  readonly padding?: number;
  readonly minLayerGap?: number;
  readonly nodeSpacingY?: number;
  readonly componentGap?: number;
  readonly isolatedCols?: number;
  readonly isolatedGapX?: number;
  readonly isolatedGapY?: number;
  readonly channelSpacing?: number;
  readonly busThreshold?: number;
  readonly cornerRadius?: number;
  readonly maxBarycenterSweeps?: number;
  readonly backLoopLaneSpacing?: number;
  readonly backLoopMargin?: number;
  readonly uniformColumnWidth?: boolean;
}

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface PositionedLayoutNode {
  readonly id: number;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly componentIndex: number;
  readonly isIsolated: boolean;
}

export interface RoutedLayoutEdge {
  readonly id: string;
  readonly sourceId: number;
  readonly targetId: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly points: ReadonlyArray<LayoutPoint>;
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly isFeedback: boolean;
  readonly reversed: boolean;
  readonly busGroupKey: string | null;
  readonly isBusMember: boolean;
  readonly slotIndex: number;
}

export interface BusTrunkSegment {
  readonly busGroupKey: string;
  readonly layerIndex: number;
  readonly sourceId: number;
  readonly x: number;
  readonly yStart: number;
  readonly yEnd: number;
  readonly path: string;
  readonly memberEdgeIds: ReadonlyArray<string>;
}

export interface BusJunctionPoint {
  readonly busGroupKey: string;
  readonly x: number;
  readonly y: number;
}

export interface HierarchicLayoutResult {
  readonly nodes: ReadonlyArray<PositionedLayoutNode>;
  readonly edges: ReadonlyArray<RoutedLayoutEdge>;
  readonly busTrunks: ReadonlyArray<BusTrunkSegment>;
  readonly junctions: ReadonlyArray<BusJunctionPoint>;
  readonly nodeById: ReadonlyMap<number, PositionedLayoutNode>;
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
  readonly componentCount: number;
  readonly isolatedCount: number;
}

interface ResolvedOptions {
  readonly padding: number;
  readonly minLayerGap: number;
  readonly nodeSpacingY: number;
  readonly componentGap: number;
  readonly isolatedCols: number | undefined;
  readonly isolatedGapX: number;
  readonly isolatedGapY: number;
  readonly channelSpacing: number;
  readonly busThreshold: number;
  readonly cornerRadius: number;
  readonly maxBarycenterSweeps: number;
  readonly backLoopLaneSpacing: number;
  readonly backLoopMargin: number;
  readonly uniformColumnWidth: boolean;
}

interface WorkingNode {
  readonly localIdx: number;
  readonly isDummy: boolean;
  readonly dummyKind: "LONG_EDGE" | "LABEL" | null;
  readonly input: LayoutNodeInput | null;
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly sortGroup: number;
  readonly ownerGroupId: number | null;
  readonly ownerOrder: number;
  readonly originEdgeIdx: number;
  layer: number;
  row: number;
  x: number;
  y: number;
}

interface WorkingEdge {
  readonly inputIdx: number;
  readonly input: LayoutEdgeInput;
  readonly origSrcLocal: number;
  readonly origDstLocal: number;
  readonly dagSrcLocal: number;
  readonly dagDstLocal: number;
  readonly reversed: boolean;
  readonly isFeedback: boolean;
  readonly priority: number;
  readonly weight: number;
  readonly minSpan: number;
}

interface SegmentLink {
  readonly edgeIdx: number;
  readonly srcLocal: number;
  readonly dstLocal: number;
  readonly layer: number;
  readonly busGroupKey: string | null;
  readonly priority: number;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

function compareNodeInputs(a: LayoutNodeInput, b: LayoutNodeInput): number {
  const ga = a.sortGroup ?? 0;
  const gb = b.sortGroup ?? 0;
  if (ga !== gb) return ga - gb;
  return a.id - b.id;
}

function compareWorkingNodes(a: WorkingNode, b: WorkingNode): number {
  if (a.ownerGroupId !== null && a.ownerGroupId === b.ownerGroupId) {
    if (a.ownerOrder !== b.ownerOrder) return a.ownerOrder - b.ownerOrder;
  }
  if (a.sortGroup !== b.sortGroup) return a.sortGroup - b.sortGroup;
  return a.id - b.id;
}

function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return !(
    a.x + a.width + pad <= b.x ||
    b.x + b.width + pad <= a.x ||
    a.y + a.height + pad <= b.y ||
    b.y + b.height + pad <= a.y
  );
}

function rectOverlapArea(a: Rect, b: Rect): number {
  const ox = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  );
  if (ox <= 0) return 0;
  const oy = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  );
  return ox * oy;
}

function resolveOptions(options?: HierarchicLayoutOptions): ResolvedOptions {
  return {
    padding: options?.padding ?? 40,
    minLayerGap: options?.minLayerGap ?? 108,
    nodeSpacingY: options?.nodeSpacingY ?? 22,
    componentGap: options?.componentGap ?? 56,
    isolatedCols: options?.isolatedCols,
    isolatedGapX: options?.isolatedGapX ?? 24,
    isolatedGapY: options?.isolatedGapY ?? 20,
    channelSpacing: options?.channelSpacing ?? 14,
    busThreshold: Math.max(2, options?.busThreshold ?? 5),
    cornerRadius: Math.max(0, options?.cornerRadius ?? 8),
    maxBarycenterSweeps: Math.max(1, options?.maxBarycenterSweeps ?? 8),
    backLoopLaneSpacing: options?.backLoopLaneSpacing ?? 24,
    backLoopMargin: options?.backLoopMargin ?? 30,
    uniformColumnWidth: options?.uniformColumnWidth ?? true,
  };
}

// ============================================================================
// Phase 1: Weakly Connected Component Partitioning & 0-Degree Isolation
// ============================================================================

interface RawComponent {
  readonly nodes: LayoutNodeInput[];
  readonly edges: LayoutEdgeInput[];
}

function partitionComponents(
  nodes: ReadonlyArray<LayoutNodeInput>,
  edges: ReadonlyArray<LayoutEdgeInput>,
): {
  readonly activeComponents: RawComponent[];
  readonly isolatedNodes: LayoutNodeInput[];
} {
  const nodeById = new Map<number, LayoutNodeInput>();
  const adj = new Map<number, number[]>();
  const incidentEdges = new Map<number, LayoutEdgeInput[]>();

  for (const node of nodes) {
    nodeById.set(node.id, node);
    adj.set(node.id, []);
    incidentEdges.set(node.id, []);
  }

  const validEdges: LayoutEdgeInput[] = [];
  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue;
    if (!nodeById.has(edge.sourceId) || !nodeById.has(edge.targetId)) continue;
    validEdges.push(edge);
    adj.get(edge.sourceId)!.push(edge.targetId);
    adj.get(edge.targetId)!.push(edge.sourceId);
    incidentEdges.get(edge.sourceId)!.push(edge);
  }

  const visited = new Set<number>();
  const activeComponents: RawComponent[] = [];
  const isolatedNodes: LayoutNodeInput[] = [];

  const sortedNodes = nodes.toSorted(compareNodeInputs);
  for (const startNode of sortedNodes) {
    if (visited.has(startNode.id)) continue;
    visited.add(startNode.id);

    const neighbors = adj.get(startNode.id)!;
    if (neighbors.length === 0) {
      isolatedNodes.push(startNode);
      continue;
    }

    const compNodes: LayoutNodeInput[] = [];
    const compEdges: LayoutEdgeInput[] = [];
    const queue: number[] = [startNode.id];
    let cursor = 0;

    while (cursor < queue.length) {
      const id = queue[cursor++]!;
      const node = nodeById.get(id)!;
      compNodes.push(node);
      for (const e of incidentEdges.get(id)!) {
        compEdges.push(e);
      }
      for (const nextId of adj.get(id)!) {
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push(nextId);
        }
      }
    }

    compNodes.sort(compareNodeInputs);
    activeComponents.push({ nodes: compNodes, edges: compEdges });
  }

  activeComponents.sort((a, b) => {
    if (b.nodes.length !== a.nodes.length) {
      return b.nodes.length - a.nodes.length;
    }
    const firstA = a.nodes[0]!;
    const firstB = b.nodes[0]!;
    return compareNodeInputs(firstA, firstB);
  });

  isolatedNodes.sort(compareNodeInputs);
  return { activeComponents, isolatedNodes };
}

// ============================================================================
// Phase 2: Cycle Removal (Weighted Eades–Lin–Smyth Greedy FAS)
// ============================================================================

function computeGreedyFasOrder(
  compNodes: ReadonlyArray<LayoutNodeInput>,
  forwardCandidateEdges: ReadonlyArray<{
    readonly srcLocal: number;
    readonly dstLocal: number;
    readonly priority: number;
  }>,
): Int32Array {
  const n = compNodes.length;
  const active = new Uint8Array(n);
  active.fill(1);

  const inDeg = new Int32Array(n);
  const outDeg = new Int32Array(n);
  const wIn = new Float64Array(n);
  const wOut = new Float64Array(n);

  const outAdj: Array<Array<{ to: number; weight: number }>> = Array.from(
    { length: n },
    () => [],
  );
  const inAdj: Array<Array<{ from: number; weight: number }>> = Array.from(
    { length: n },
    () => [],
  );

  for (const e of forwardCandidateEdges) {
    const w = Math.max(0.25, e.priority + 2);
    outAdj[e.srcLocal]!.push({ to: e.dstLocal, weight: w });
    inAdj[e.dstLocal]!.push({ from: e.srcLocal, weight: w });
    outDeg[e.srcLocal] = (outDeg[e.srcLocal] ?? 0) + 1;
    inDeg[e.dstLocal] = (inDeg[e.dstLocal] ?? 0) + 1;
    wOut[e.srcLocal] = (wOut[e.srcLocal] ?? 0) + w;
    wIn[e.dstLocal] = (wIn[e.dstLocal] ?? 0) + w;
  }

  const s1: number[] = [];
  const s2: number[] = [];

  const removeVertex = (u: number) => {
    active[u] = 0;
    for (const edge of outAdj[u]!) {
      if (active[edge.to] === 1) {
        inDeg[edge.to] = (inDeg[edge.to] ?? 0) - 1;
        wIn[edge.to] = Math.max(0, (wIn[edge.to] ?? 0) - edge.weight);
      }
    }
    for (const edge of inAdj[u]!) {
      if (active[edge.from] === 1) {
        outDeg[edge.from] = (outDeg[edge.from] ?? 0) - 1;
        wOut[edge.from] = Math.max(0, (wOut[edge.from] ?? 0) - edge.weight);
      }
    }
  };

  while (s1.length + s2.length < n) {
    let progressed = true;
    while (progressed && s1.length + s2.length < n) {
      progressed = false;
      for (let u = 0; u < n; u++) {
        if (active[u] === 1 && outDeg[u] === 0 && (inDeg[u] ?? 0) > 0) {
          s2.push(u);
          removeVertex(u);
          progressed = true;
        }
      }
      for (let u = 0; u < n; u++) {
        if (active[u] === 1 && inDeg[u] === 0) {
          s1.push(u);
          removeVertex(u);
          progressed = true;
        }
      }
    }

    if (s1.length + s2.length >= n) break;

    let bestU = -1;
    let bestDelta = -Infinity;
    let bestDegDiff = -Infinity;

    for (let u = 0; u < n; u++) {
      if (active[u] !== 1) continue;
      const delta = (wOut[u] ?? 0) - (wIn[u] ?? 0);
      const degDiff = (outDeg[u] ?? 0) - (inDeg[u] ?? 0);
      if (
        bestU === -1 ||
        delta > bestDelta + 1e-9 ||
        (Math.abs(delta - bestDelta) <= 1e-9 &&
          (degDiff > bestDegDiff ||
            (degDiff === bestDegDiff &&
              compareNodeInputs(compNodes[u]!, compNodes[bestU]!) < 0)))
      ) {
        bestU = u;
        bestDelta = delta;
        bestDegDiff = degDiff;
      }
    }

    if (bestU !== -1) {
      s1.push(bestU);
      removeVertex(bestU);
    }
  }

  const orderPos = new Int32Array(n);
  let pos = 0;
  for (const u of s1) {
    orderPos[u] = pos++;
  }
  for (let i = s2.length - 1; i >= 0; i--) {
    orderPos[s2[i]!] = pos++;
  }
  return orderPos;
}

// ============================================================================
// Phase 3: Network Simplex Rank Assignment + Balancing + Owner Grouping
// ============================================================================

interface SimplexEdge {
  readonly tail: number;
  readonly head: number;
  readonly weight: number;
  readonly minSpan: number;
}

function solveNetworkSimplexSubgraph(
  subNodes: ReadonlyArray<number>,
  subEdges: ReadonlyArray<SimplexEdge>,
  globalRanks: Int32Array,
): void {
  const n = subNodes.length;
  if (n === 0) return;
  if (n === 1 || subEdges.length === 0) {
    for (const globalIdx of subNodes) {
      globalRanks[globalIdx] = 0;
    }
    return;
  }

  const localOfGlobal = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    localOfGlobal.set(subNodes[i]!, i);
  }

  const edges: SimplexEdge[] = [];
  const outList: number[][] = Array.from({ length: n }, () => []);
  const inList: number[][] = Array.from({ length: n }, () => []);
  const inDeg = new Int32Array(n);
  const netWeight = new Float64Array(n);

  for (const e of subEdges) {
    const tail = localOfGlobal.get(e.tail)!;
    const head = localOfGlobal.get(e.head)!;
    if (tail === head) continue;
    const idx = edges.length;
    edges.push({ tail, head, weight: e.weight, minSpan: e.minSpan });
    outList[tail]!.push(idx);
    inList[head]!.push(idx);
    inDeg[head] = (inDeg[head] ?? 0) + 1;
    netWeight[tail] = (netWeight[tail] ?? 0) + e.weight;
    netWeight[head] = (netWeight[head] ?? 0) - e.weight;
  }

  // Step 1: Initial feasible ranks via topological Kahn pass
  const rank = new Int32Array(n);
  const remIn = new Int32Array(inDeg);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (remIn[i] === 0) queue.push(i);
  }
  let qHead = 0;
  while (qHead < queue.length) {
    const u = queue[qHead++]!;
    for (const eIdx of outList[u]!) {
      const e = edges[eIdx]!;
      const nextRank = (rank[u] ?? 0) + e.minSpan;
      if (nextRank > (rank[e.head] ?? 0)) {
        rank[e.head] = nextRank;
      }
      const nextIn = (remIn[e.head] ?? 0) - 1;
      remIn[e.head] = nextIn;
      if (nextIn === 0) queue.push(e.head);
    }
  }

  // Step 2: Construct initial tight spanning tree
  const eCount = edges.length;
  const isTreeEdge = new Uint8Array(eCount);
  const inTree = new Uint8Array(n);
  const incUndirected: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < eCount; i++) {
    const e = edges[i]!;
    incUndirected[e.tail]!.push(i);
    incUndirected[e.head]!.push(i);
  }

  const growTightTree = () => {
    const bfs: number[] = [];
    for (let i = 0; i < n; i++) {
      if (inTree[i] === 1) bfs.push(i);
    }
    let head = 0;
    while (head < bfs.length) {
      const u = bfs[head++]!;
      for (const eIdx of incUndirected[u]!) {
        const e = edges[eIdx]!;
        const v = e.tail === u ? e.head : e.tail;
        if (inTree[v] === 1) continue;
        const slack = (rank[e.head] ?? 0) - (rank[e.tail] ?? 0) - e.minSpan;
        if (slack === 0) {
          inTree[v] = 1;
          isTreeEdge[eIdx] = 1;
          bfs.push(v);
        }
      }
    }
  };

  inTree[0] = 1;
  let treeNodesCount = 1;
  growTightTree();
  treeNodesCount = 0;
  for (let i = 0; i < n; i++) {
    if (inTree[i] === 1) treeNodesCount++;
  }

  while (treeNodesCount < n) {
    let bestEdge = -1;
    let bestSlack = Infinity;
    let shiftDir = 0; // +1 means tree vertex is tail, -1 means tree vertex is head

    for (let i = 0; i < eCount; i++) {
      const e = edges[i]!;
      const tailIn = inTree[e.tail] === 1;
      const headIn = inTree[e.head] === 1;
      if (tailIn === headIn) continue;
      const slack = (rank[e.head] ?? 0) - (rank[e.tail] ?? 0) - e.minSpan;
      if (slack < bestSlack) {
        bestSlack = slack;
        bestEdge = i;
        shiftDir = tailIn ? 1 : -1;
      }
    }

    if (bestEdge === -1) break;
    const delta = shiftDir * bestSlack;
    if (delta !== 0) {
      for (let i = 0; i < n; i++) {
        if (inTree[i] === 1) {
          rank[i] = (rank[i] ?? 0) + delta;
        }
      }
    }

    const chosen = edges[bestEdge]!;
    isTreeEdge[bestEdge] = 1;
    inTree[chosen.tail] = 1;
    inTree[chosen.head] = 1;
    growTightTree();
    treeNodesCount = 0;
    for (let i = 0; i < n; i++) {
      if (inTree[i] === 1) treeNodesCount++;
    }
  }

  // Step 3: Network Simplex pivoting using subtree cut values
  const treeAdj: Array<Array<{ neighbor: number; edgeIdx: number }>> =
    Array.from({ length: n }, () => []);
  const parent = new Int32Array(n);
  const parentEdge = new Int32Array(n);
  const low = new Int32Array(n);
  const lim = new Int32Array(n);
  const subtreeNet = new Float64Array(n);
  const cutValue = new Float64Array(eCount);

  const rebuildTreeInfo = () => {
    for (let i = 0; i < n; i++) {
      treeAdj[i]!.length = 0;
      parent[i] = -1;
      parentEdge[i] = -1;
    }
    for (let i = 0; i < eCount; i++) {
      if (isTreeEdge[i] !== 1) continue;
      const e = edges[i]!;
      treeAdj[e.tail]!.push({ neighbor: e.head, edgeIdx: i });
      treeAdj[e.head]!.push({ neighbor: e.tail, edgeIdx: i });
    }

    let postCounter = 0;
    const stackNode: number[] = [0];
    const stackStage: number[] = [0];
    parent[0] = 0;

    while (stackNode.length > 0) {
      const idx = stackNode.length - 1;
      const u = stackNode[idx]!;
      const stage = stackStage[idx]!;

      if (stage === 0) {
        stackStage[idx] = 1;
        low[u] = postCounter + 1;
        subtreeNet[u] = netWeight[u] ?? 0;
        for (const item of treeAdj[u]!) {
          if (item.neighbor === parent[u]) continue;
          parent[item.neighbor] = u;
          parentEdge[item.neighbor] = item.edgeIdx;
          stackNode.push(item.neighbor);
          stackStage.push(0);
        }
      } else {
        stackNode.pop();
        stackStage.pop();
        postCounter++;
        lim[u] = postCounter;
        if (u !== 0) {
          const p = parent[u]!;
          subtreeNet[p] = (subtreeNet[p] ?? 0) + (subtreeNet[u] ?? 0);
          const pe = parentEdge[u]!;
          const edge = edges[pe]!;
          cutValue[pe] =
            edge.tail === p ? -(subtreeNet[u] ?? 0) : (subtreeNet[u] ?? 0);
        }
      }
    }
  };

  const maxPivots = Math.max(256, n * 8);
  let zeroPivotStreak = 0;

  for (let iter = 0; iter < maxPivots; iter++) {
    rebuildTreeInfo();

    let leavingEdge = -1;
    let minCut = -1e-9;
    for (let i = 0; i < eCount; i++) {
      if (isTreeEdge[i] !== 1) continue;
      const cv = cutValue[i] ?? 0;
      if (cv < minCut) {
        minCut = cv;
        leavingEdge = i;
      }
    }
    if (leavingEdge === -1) break;

    const le = edges[leavingEdge]!;
    const child = parent[le.head] === le.tail ? le.head : le.tail;
    const childLow = low[child] ?? 0;
    const childLim = lim[child] ?? 0;
    const headIsSubtree = child === le.head;

    const isInHeadComp = (v: number): boolean => {
      const post = lim[v] ?? 0;
      const inSubtree = post >= childLow && post <= childLim;
      return headIsSubtree ? inSubtree : !inSubtree;
    };

    let enteringEdge = -1;
    let minSlack = Infinity;

    for (let i = 0; i < eCount; i++) {
      if (isTreeEdge[i] === 1) continue;
      const f = edges[i]!;
      // Must go from HeadComp -> TailComp so increasing HeadComp reduces slack(f)
      if (!isInHeadComp(f.tail) || isInHeadComp(f.head)) continue;
      const slack = (rank[f.head] ?? 0) - (rank[f.tail] ?? 0) - f.minSpan;
      if (slack < minSlack) {
        minSlack = slack;
        enteringEdge = i;
      }
    }

    if (enteringEdge === -1) break;

    if (minSlack === 0) {
      zeroPivotStreak++;
      if (zeroPivotStreak > n) break;
    } else {
      zeroPivotStreak = 0;
      for (let v = 0; v < n; v++) {
        if (isInHeadComp(v)) {
          rank[v] = (rank[v] ?? 0) + minSlack;
        }
      }
    }

    isTreeEdge[leavingEdge] = 0;
    isTreeEdge[enteringEdge] = 1;
  }

  let minRank = Infinity;
  for (let i = 0; i < n; i++) {
    if ((rank[i] ?? 0) < minRank) minRank = rank[i] ?? 0;
  }
  for (let i = 0; i < n; i++) {
    globalRanks[subNodes[i]!] = (rank[i] ?? 0) - minRank;
  }
}

function assignRanks(
  compNodes: ReadonlyArray<LayoutNodeInput>,
  workingEdges: ReadonlyArray<WorkingEdge>,
  localIndexById: ReadonlyMap<number, number>,
): Int32Array {
  const n = compNodes.length;
  const ranks = new Int32Array(n);

  // Partition working DAG into undirected subcomponents (feedback edges excluded from rank DAG)
  const forwardAdj: number[][] = Array.from({ length: n }, () => []);
  const forwardOutEdges: WorkingEdge[][] = Array.from({ length: n }, () => []);
  const forwardInEdges: WorkingEdge[][] = Array.from({ length: n }, () => []);

  for (const e of workingEdges) {
    if (e.isFeedback) continue;
    forwardAdj[e.dagSrcLocal]!.push(e.dagDstLocal);
    forwardAdj[e.dagDstLocal]!.push(e.dagSrcLocal);
    forwardOutEdges[e.dagSrcLocal]!.push(e);
    forwardInEdges[e.dagDstLocal]!.push(e);
  }

  const visited = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (visited[i] === 1) continue;
    visited[i] = 1;
    const subNodes: number[] = [];
    const subEdges: SimplexEdge[] = [];
    const queue: number[] = [i];
    let qHead = 0;

    while (qHead < queue.length) {
      const u = queue[qHead++]!;
      subNodes.push(u);
      for (const e of forwardOutEdges[u]!) {
        subEdges.push({
          tail: e.dagSrcLocal,
          head: e.dagDstLocal,
          weight: e.weight,
          minSpan: e.minSpan,
        });
      }
      for (const next of forwardAdj[u]!) {
        if (visited[next] !== 1) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }

    solveNetworkSimplexSubgraph(subNodes, subEdges, ranks);
  }

  // Respect semantic minimum layer hint for disconnected subroots when feasible
  for (let i = 0; i < n; i++) {
    const hint = compNodes[i]!.minLayerHint;
    if (hint === undefined || hint <= 0) continue;
    if (forwardInEdges[i]!.length > 0) continue;
    if (forwardOutEdges[i]!.length === 0) {
      ranks[i] = Math.max(ranks[i] ?? 0, hint);
    } else {
      let maxAllowed = Infinity;
      for (const e of forwardOutEdges[i]!) {
        const cap = (ranks[e.dagDstLocal] ?? 0) - e.minSpan;
        if (cap < maxAllowed) maxAllowed = cap;
      }
      if (hint <= maxAllowed) {
        ranks[i] = Math.max(ranks[i] ?? 0, hint);
      }
    }
  }

  // Layer balancing (Gansner et al. Section 2.3): shift slack-free equal-weight nodes
  // into sparser layers without pulling owner-anchored leaf dependents
  let maxRank = 0;
  for (let i = 0; i < n; i++) {
    if ((ranks[i] ?? 0) > maxRank) maxRank = ranks[i] ?? 0;
  }
  const layerCounts = new Int32Array(maxRank + 1);
  for (let i = 0; i < n; i++) {
    const r = ranks[i] ?? 0;
    layerCounts[r] = (layerCounts[r] ?? 0) + 1;
  }

  for (let i = 0; i < n; i++) {
    const input = compNodes[i]!;
    if (input.anchorToOwner) continue;
    const ins = forwardInEdges[i]!;
    const outs = forwardOutEdges[i]!;
    if (ins.length === 0 || outs.length === 0) continue;

    let inW = 0;
    let outW = 0;
    let earliest = 0;
    let latest = maxRank;
    for (const e of ins) {
      inW += e.weight;
      earliest = Math.max(earliest, (ranks[e.dagSrcLocal] ?? 0) + e.minSpan);
    }
    for (const e of outs) {
      outW += e.weight;
      latest = Math.min(latest, (ranks[e.dagDstLocal] ?? 0) - e.minSpan);
    }

    if (Math.abs(inW - outW) > 1e-6 || earliest >= latest) continue;
    const current = ranks[i] ?? 0;
    let bestLayer = current;
    let bestCount = layerCounts[current] ?? 0;
    for (let l = earliest; l <= latest; l++) {
      const c = layerCounts[l] ?? 0;
      if (c < bestCount) {
        bestCount = c;
        bestLayer = l;
      }
    }
    if (bestLayer !== current) {
      layerCounts[current] = Math.max(0, (layerCounts[current] ?? 0) - 1);
      layerCounts[bestLayer] = (layerCounts[bestLayer] ?? 0) + 1;
      ranks[i] = bestLayer;
    }
  }

  // Owner-group rank anchoring: leaf dependents stay tightly at ownerRank + 1
  for (let i = 0; i < n; i++) {
    const input = compNodes[i]!;
    if (!input.anchorToOwner || input.ownerGroupId == null) continue;
    const ownerLocal = localIndexById.get(input.ownerGroupId);
    if (ownerLocal === undefined || ownerLocal === i) continue;
    if (forwardOutEdges[i]!.length > 0) continue;

    const ownerRank = ranks[ownerLocal] ?? 0;
    let minAllowed = ownerRank + 1;
    let blockedByHigherPred = false;
    for (const e of forwardInEdges[i]!) {
      const predRank = ranks[e.dagSrcLocal] ?? 0;
      minAllowed = Math.max(minAllowed, predRank + e.minSpan);
      if (predRank > ownerRank) {
        blockedByHigherPred = true;
      }
    }
    if (!blockedByHigherPred || (ranks[i] ?? 0) < minAllowed) {
      ranks[i] = minAllowed;
    }
  }

  let minRank = Infinity;
  for (let i = 0; i < n; i++) {
    if ((ranks[i] ?? 0) < minRank) minRank = ranks[i] ?? 0;
  }
  if (minRank !== 0 && Number.isFinite(minRank)) {
    for (let i = 0; i < n; i++) {
      ranks[i] = (ranks[i] ?? 0) - minRank;
    }
  }

  return ranks;
}

// ============================================================================
// Phase 4: Proper Layering (LONG_EDGE & LABEL Dummies) + Crossing Reduction
// ============================================================================

interface ProperGraph {
  readonly nodes: WorkingNode[];
  readonly layers: number[][];
  readonly adjOut: number[][];
  readonly adjIn: number[][];
  readonly segsByGutter: SegmentLink[][];
  readonly edgeChains: number[][]; // per working edge index: ordered dummy + endpoint local indices
  readonly edgeSegLinks: SegmentLink[][];
}

function buildProperGraph(
  compNodes: ReadonlyArray<LayoutNodeInput>,
  workingEdges: ReadonlyArray<WorkingEdge>,
  ranks: Int32Array,
): ProperGraph {
  const nodes: WorkingNode[] = [];
  let maxRank = 0;

  for (let i = 0; i < compNodes.length; i++) {
    const input = compNodes[i]!;
    const layer = ranks[i] ?? 0;
    if (layer > maxRank) maxRank = layer;
    nodes.push({
      localIdx: i,
      isDummy: false,
      dummyKind: null,
      input,
      id: input.id,
      width: input.width,
      height: input.height,
      sortGroup: input.sortGroup ?? 0,
      ownerGroupId: input.ownerGroupId ?? null,
      ownerOrder: input.ownerOrder ?? 0,
      originEdgeIdx: -1,
      layer,
      row: 0,
      x: 0,
      y: 0,
    });
  }

  const edgeChains: number[][] = Array.from(
    { length: workingEdges.length },
    () => [],
  );
  const edgeSegLinks: SegmentLink[][] = Array.from(
    { length: workingEdges.length },
    () => [],
  );

  let nextDummyId = -1;
  for (let eIdx = 0; eIdx < workingEdges.length; eIdx++) {
    const e = workingEdges[eIdx]!;
    if (e.isFeedback) continue;

    const srcRank = nodes[e.dagSrcLocal]!.layer;
    const dstRank = nodes[e.dagDstLocal]!.layer;
    const span = dstRank - srcRank;
    if (span <= 0) continue;

    const chain: number[] = [e.dagSrcLocal];
    if (span >= 2) {
      const labelWidth = e.input.labelWidth ?? 0;
      const labelHeight = e.input.labelHeight ?? 18;
      const labelOffset = Math.floor(span / 2);

      for (let step = 1; step < span; step++) {
        const isLabelDummy = labelWidth > 0 && step === labelOffset;
        const dummyLocal = nodes.length;
        nodes.push({
          localIdx: dummyLocal,
          isDummy: true,
          dummyKind: isLabelDummy ? "LABEL" : "LONG_EDGE",
          input: null,
          id: nextDummyId--,
          width: isLabelDummy ? Math.min(180, Math.max(24, labelWidth)) : 8,
          height: isLabelDummy ? Math.max(18, labelHeight) : 6,
          sortGroup: 999,
          ownerGroupId: null,
          ownerOrder: 0,
          originEdgeIdx: eIdx,
          layer: srcRank + step,
          row: 0,
          x: 0,
          y: 0,
        });
        chain.push(dummyLocal);
      }
    }
    chain.push(e.dagDstLocal);
    edgeChains[eIdx] = chain;
  }

  const numLayers = maxRank + 1;
  const layers: number[][] = Array.from({ length: numLayers }, () => []);
  for (const node of nodes) {
    layers[node.layer]!.push(node.localIdx);
  }
  for (const layerNodes of layers) {
    layerNodes.sort((a, b) => compareWorkingNodes(nodes[a]!, nodes[b]!));
  }

  const adjOut: number[][] = Array.from({ length: nodes.length }, () => []);
  const adjIn: number[][] = Array.from({ length: nodes.length }, () => []);
  const segsByGutter: SegmentLink[][] = Array.from(
    { length: Math.max(0, numLayers - 1) },
    () => [],
  );

  for (let eIdx = 0; eIdx < workingEdges.length; eIdx++) {
    const e = workingEdges[eIdx]!;
    const chain = edgeChains[eIdx]!;
    if (chain.length < 2) continue;

    for (let k = 0; k < chain.length - 1; k++) {
      const u = chain[k]!;
      const v = chain[k + 1]!;
      const gutter = nodes[u]!.layer;
      adjOut[u]!.push(v);
      adjIn[v]!.push(u);
      const link: SegmentLink = {
        edgeIdx: eIdx,
        srcLocal: u,
        dstLocal: v,
        layer: gutter,
        busGroupKey: e.input.busGroupKey ?? null,
        priority: e.priority,
      };
      segsByGutter[gutter]!.push(link);
      edgeSegLinks[eIdx]!.push(link);
    }
  }

  return {
    nodes,
    layers,
    adjOut,
    adjIn,
    segsByGutter,
    edgeChains,
    edgeSegLinks,
  };
}

function countBilayerCrossings(
  leftLayer: ReadonlyArray<number>,
  rightLayer: ReadonlyArray<number>,
  segs: ReadonlyArray<SegmentLink>,
  posInLayer: Int32Array,
): number {
  if (segs.length <= 1 || leftLayer.length <= 1 || rightLayer.length <= 1) {
    return 0;
  }

  // Sort edges by left pos ascending, then right pos ascending (free port ordering)
  const pairs: Array<{ lPos: number; rPos: number }> = [];
  for (const seg of segs) {
    pairs.push({
      lPos: posInLayer[seg.srcLocal] ?? 0,
      rPos: posInLayer[seg.dstLocal] ?? 0,
    });
  }
  pairs.sort((a, b) => (a.lPos !== b.lPos ? a.lPos - b.lPos : a.rPos - b.rPos));

  // Waddle–Malhotra Fenwick tree inversion counter over right indices (1-based BIT)
  const treeSize = rightLayer.length + 1;
  const bit = new Int32Array(treeSize);
  let crossings = 0;
  let totalInserted = 0;

  for (const pair of pairs) {
    const idx = pair.rPos + 1;
    let leCount = 0;
    for (let j = idx; j > 0; j -= j & -j) {
      leCount += bit[j] ?? 0;
    }
    crossings += totalInserted - leCount;
    for (let j = idx; j < treeSize; j += j & -j) {
      bit[j] = (bit[j] ?? 0) + 1;
    }
    totalInserted++;
  }

  return crossings;
}

function countTotalCrossings(
  graph: ProperGraph,
  posInLayer: Int32Array,
): number {
  let total = 0;
  for (let g = 0; g < graph.segsByGutter.length; g++) {
    total += countBilayerCrossings(
      graph.layers[g]!,
      graph.layers[g + 1]!,
      graph.segsByGutter[g]!,
      posInLayer,
    );
  }
  return total;
}

function syncPositions(
  layers: ReadonlyArray<ReadonlyArray<number>>,
  posInLayer: Int32Array,
): void {
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i++) {
      posInLayer[layer[i]!] = i;
    }
  }
}

function sortLayerWithOwnerClusters(
  layer: number[],
  nodes: ReadonlyArray<WorkingNode>,
  neighborAdj: ReadonlyArray<ReadonlyArray<number>>,
  reverseNeighborAdj: ReadonlyArray<ReadonlyArray<number>>,
  posInLayer: Int32Array,
): void {
  if (layer.length <= 1) return;

  // Build port-rank-aware barycenter per node
  const nodeScore = new Float64Array(nodes.length);
  const hasNeighbors = new Uint8Array(nodes.length);

  // Precompute normalized port offset [-0.32..+0.32] per neighbor for multi-edge hubs
  const neighborPortCache = new Map<number, ReadonlyArray<number>>();
  const getNeighborPortRank = (
    nodeIdx: number,
    neighborIdx: number,
  ): number => {
    const basePos = posInLayer[neighborIdx] ?? 0;
    let peers = neighborPortCache.get(neighborIdx);
    if (!peers) {
      const sortedPeers = reverseNeighborAdj[neighborIdx]!.toSorted(
        (a, b) => (posInLayer[a] ?? 0) - (posInLayer[b] ?? 0),
      );
      neighborPortCache.set(neighborIdx, sortedPeers);
      peers = sortedPeers;
    }
    if (peers.length <= 1) return basePos;
    const slot = peers.indexOf(nodeIdx);
    if (slot < 0) return basePos;
    const frac = slot / (peers.length - 1) - 0.5;
    return basePos + frac * 0.64;
  };

  for (let i = 0; i < layer.length; i++) {
    const u = layer[i]!;
    const neighbors = neighborAdj[u]!;
    if (neighbors.length === 0) {
      nodeScore[u] = i;
      continue;
    }
    let sum = 0;
    for (const w of neighbors) {
      sum += getNeighborPortRank(u, w);
    }
    nodeScore[u] = sum / neighbors.length;
    hasNeighbors[u] = 1;
  }

  // Group nodes into contiguous owner blocks (Forster 2005 two-level cluster barycenter)
  interface ClusterBlock {
    readonly ownerGroupId: number | null;
    readonly members: number[];
    readonly score: number;
    readonly minMemberIdx: number;
  }

  const ownerGroups = new Map<number, number[]>();
  const singletons: number[] = [];

  for (const u of layer) {
    const ownerId = nodes[u]!.ownerGroupId;
    if (ownerId !== null && !nodes[u]!.isDummy) {
      const bucket = ownerGroups.get(ownerId);
      if (bucket) bucket.push(u);
      else ownerGroups.set(ownerId, [u]);
    } else {
      singletons.push(u);
    }
  }

  const clusters: ClusterBlock[] = [];
  for (const [ownerGroupId, members] of ownerGroups.entries()) {
    members.sort((a, b) => {
      const sa = nodeScore[a] ?? 0;
      const sb = nodeScore[b] ?? 0;
      if (Math.abs(sa - sb) > 1e-6) return sa - sb;
      return compareWorkingNodes(nodes[a]!, nodes[b]!);
    });
    let sum = 0;
    let count = 0;
    let fallbackSum = 0;
    for (const m of members) {
      fallbackSum += nodeScore[m] ?? 0;
      if (hasNeighbors[m] === 1) {
        sum += nodeScore[m] ?? 0;
        count++;
      }
    }
    clusters.push({
      ownerGroupId,
      members,
      score: count > 0 ? sum / count : fallbackSum / members.length,
      minMemberIdx: Math.min(...members),
    });
  }

  for (const u of singletons) {
    clusters.push({
      ownerGroupId: null,
      members: [u],
      score: nodeScore[u] ?? 0,
      minMemberIdx: u,
    });
  }

  clusters.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-6) return a.score - b.score;
    return compareWorkingNodes(nodes[a.minMemberIdx]!, nodes[b.minMemberIdx]!);
  });

  let writeIdx = 0;
  for (const cluster of clusters) {
    for (const m of cluster.members) {
      layer[writeIdx++] = m;
    }
  }
}

function reduceCrossings(graph: ProperGraph, maxSweeps: number): void {
  const { layers, nodes, adjIn, adjOut } = graph;
  if (layers.length <= 1) {
    for (const layer of layers) {
      for (let i = 0; i < layer.length; i++) {
        nodes[layer[i]!]!.row = i;
      }
    }
    return;
  }

  const posInLayer = new Int32Array(nodes.length);
  syncPositions(layers, posInLayer);

  let bestCrossings = countTotalCrossings(graph, posInLayer);
  let bestSnapshot = layers.map((l) => [...l]);

  const tryCommitBest = () => {
    syncPositions(layers, posInLayer);
    const current = countTotalCrossings(graph, posInLayer);
    if (current < bestCrossings) {
      bestCrossings = current;
      bestSnapshot = layers.map((l) => [...l]);
      return true;
    }
    return false;
  };

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    if (bestCrossings === 0) break;
    let improved = false;

    // Forward pass (left -> right)
    for (let l = 1; l < layers.length; l++) {
      sortLayerWithOwnerClusters(layers[l]!, nodes, adjIn, adjOut, posInLayer);
      syncPositions([layers[l]!], posInLayer);
    }
    if (tryCommitBest()) improved = true;

    if (bestCrossings === 0) break;

    // Backward pass (right -> left)
    for (let l = layers.length - 2; l >= 0; l--) {
      sortLayerWithOwnerClusters(layers[l]!, nodes, adjOut, adjIn, posInLayer);
      syncPositions([layers[l]!], posInLayer);
    }
    if (tryCommitBest()) improved = true;

    // O(deg(a)*deg(b)) adjacent-pair transpose refinement (preserving ownerGroupId contiguity)
    let transposed = true;
    let transposeLoops = 0;
    while (transposed && transposeLoops < 3) {
      transposed = false;
      transposeLoops++;
      for (let l = 0; l < layers.length; l++) {
        const layer = layers[l]!;
        for (let i = 0; i < layer.length - 1; i++) {
          const a = layer[i]!;
          const b = layer[i + 1]!;
          const ogA = nodes[a]!.ownerGroupId;
          const ogB = nodes[b]!.ownerGroupId;
          if (ogA !== ogB) {
            const leftNeighborSameA =
              i > 0 &&
              ogA !== null &&
              nodes[layer[i - 1]!]!.ownerGroupId === ogA;
            const rightNeighborSameB =
              i + 2 < layer.length &&
              ogB !== null &&
              nodes[layer[i + 2]!]!.ownerGroupId === ogB;
            if (leftNeighborSameA || rightNeighborSameB) continue;
          }

          let before = 0;
          let after = 0;
          const inA = adjIn[a]!;
          const inB = adjIn[b]!;
          for (const paNode of inA) {
            const pa = posInLayer[paNode] ?? 0;
            for (const pbNode of inB) {
              const pb = posInLayer[pbNode] ?? 0;
              if (pa > pb) before++;
              else if (pb > pa) after++;
            }
          }
          const outA = adjOut[a]!;
          const outB = adjOut[b]!;
          for (const qaNode of outA) {
            const qa = posInLayer[qaNode] ?? 0;
            for (const qbNode of outB) {
              const qb = posInLayer[qbNode] ?? 0;
              if (qa > qb) before++;
              else if (qb > qa) after++;
            }
          }

          if (after < before) {
            layer[i] = b;
            layer[i + 1] = a;
            posInLayer[b] = i;
            posInLayer[a] = i + 1;
            transposed = true;
            improved = true;
          }
        }
      }
      if (tryCommitBest()) improved = true;
    }

    if (!improved) break;
  }

  for (let l = 0; l < layers.length; l++) {
    layers[l] = bestSnapshot[l]!;
    for (let r = 0; r < layers[l]!.length; r++) {
      nodes[layers[l]![r]!]!.row = r;
    }
  }
}

// ============================================================================
// Phase 5: 4-Pass Brandes–Köpf + 2020 Erratum (arXiv:2008.01252)
// ============================================================================

function pairKey(u: number, v: number): string {
  return `${u}:${v}`;
}

function markConflicts(graph: ProperGraph): {
  readonly type1: ReadonlySet<string>;
  readonly type2: ReadonlySet<string>;
} {
  const { layers, nodes, adjIn } = graph;
  const type1 = new Set<string>();
  const type2 = new Set<string>();

  for (let i = 1; i < layers.length - 1; i++) {
    const currLayer = layers[i + 1]!;
    const prevLayer = layers[i]!;
    let k0 = 0;
    let l = 0;

    for (let l1 = 0; l1 < currLayer.length; l1++) {
      const v = currLayer[l1]!;
      let innerU = -1;
      if (nodes[v]!.isDummy) {
        for (const u of adjIn[v]!) {
          if (nodes[u]!.isDummy) {
            innerU = u;
            break;
          }
        }
      }

      if (l1 === currLayer.length - 1 || innerU !== -1) {
        const k1 = innerU !== -1 ? nodes[innerU]!.row : prevLayer.length - 1;
        while (l <= l1) {
          const w = currLayer[l]!;
          for (const u of adjIn[w]!) {
            const uIsInner = nodes[w]!.isDummy && nodes[u]!.isDummy;
            if (uIsInner) continue;
            const k = nodes[u]!.row;
            if (k < k0 || k > k1) {
              type1.add(pairKey(u, w));
            }
          }
          l++;
        }
        k0 = k1;
      }
    }

    // Type 2 conflicts: if two inner segments cross, mark the lower-priority/later one
    const innerPairs: Array<{ u: number; v: number; rU: number; rV: number }> =
      [];
    for (const v of currLayer) {
      if (!nodes[v]!.isDummy) continue;
      for (const u of adjIn[v]!) {
        if (nodes[u]!.isDummy) {
          innerPairs.push({ u, v, rU: nodes[u]!.row, rV: nodes[v]!.row });
        }
      }
    }
    for (let a = 0; a < innerPairs.length; a++) {
      for (let b = a + 1; b < innerPairs.length; b++) {
        const pa = innerPairs[a]!;
        const pb = innerPairs[b]!;
        if (
          (pa.rU < pb.rU && pa.rV > pb.rV) ||
          (pa.rU > pb.rU && pa.rV < pb.rV)
        ) {
          type2.add(pairKey(pb.u, pb.v));
        }
      }
    }
  }

  return { type1, type2 };
}

function getVerticalGap(
  a: WorkingNode,
  b: WorkingNode,
  nodeSpacingY: number,
): number {
  if (a.isDummy && b.isDummy) {
    if (a.dummyKind === "LONG_EDGE" && b.dummyKind === "LONG_EDGE") {
      return 12;
    }
    return Math.max(12, Math.round(nodeSpacingY * 0.65));
  }
  if (a.isDummy || b.isDummy) {
    return Math.max(12, Math.round(nodeSpacingY * 0.72));
  }
  return nodeSpacingY;
}

function runBrandesKopfPass(
  graph: ProperGraph,
  conflicts: {
    readonly type1: ReadonlySet<string>;
    readonly type2: ReadonlySet<string>;
  },
  dirH: 1 | -1,
  dirV: 1 | -1,
  nodeSpacingY: number,
): Float64Array {
  const { layers, nodes, adjIn, adjOut } = graph;
  const n = nodes.length;
  const root = new Int32Array(n);
  const align = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    root[i] = i;
    align[i] = i;
  }

  // Step 1: Vertical alignment (forming straight horizontal blocks)
  const startLayer = dirH === 1 ? 1 : layers.length - 2;
  const endLayer = dirH === 1 ? layers.length : -1;

  for (let l = startLayer; l !== endLayer; l += dirH) {
    const layer = layers[l]!;
    const neighborList = dirH === 1 ? adjIn : adjOut;
    let r = dirV === 1 ? -1 : Infinity;

    const startRow = dirV === 1 ? 0 : layer.length - 1;
    const endRow = dirV === 1 ? layer.length : -1;

    for (let idx = startRow; idx !== endRow; idx += dirV) {
      const v = layer[idx]!;
      const neighbors = neighborList[v]!;
      if (neighbors.length === 0) continue;

      const sortedNeighbors = neighbors.toSorted(
        (a, b) => nodes[a]!.row - nodes[b]!.row,
      );
      const d = sortedNeighbors.length;
      const m1 = Math.floor((d - 1) / 2);
      const m2 = Math.ceil((d - 1) / 2);
      const medians = m1 === m2 ? [m1] : dirV === 1 ? [m1, m2] : [m2, m1];

      for (const mIdx of medians) {
        if (align[v] !== v) break;
        const u = sortedNeighbors[mIdx]!;
        const conflictKey = dirH === 1 ? pairKey(u, v) : pairKey(v, u);
        if (
          conflicts.type1.has(conflictKey) ||
          conflicts.type2.has(conflictKey)
        ) {
          continue;
        }
        const posU = nodes[u]!.row;
        const monotonicOk = dirV === 1 ? r < posU : r > posU;
        if (monotonicOk) {
          align[u] = v;
          root[v] = root[u]!;
          align[v] = root[v]!;
          r = posU;
        }
      }
    }
  }

  // Step 2: Port- and variable-height-aware insideBlockShift
  // For dirV === 1, work directly in Y; for dirV === -1, mirror Y' = -Y so inequalities stay identical
  const insideShift = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rNode = nodes[root[i]!]!;
    const iNode = nodes[i]!;
    insideShift[i] =
      dirV === 1
        ? (rNode.height - iNode.height) / 2
        : (iNode.height - rNode.height) / 2;
  }

  // Step 3: Sink-class compaction + 2020 Erratum Class DAG (arXiv:2008.01252)
  const sink = new Int32Array(n);
  const blockX = new Float64Array(n);
  const blockAssigned = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    sink[i] = i;
    blockX[i] = 0;
  }

  interface CrossClassEdge {
    readonly uBlock: number;
    readonly vBlock: number;
    readonly requiredDelta: number;
  }
  const crossConstraints: CrossClassEdge[] = [];

  const placeBlock = (vRoot: number): void => {
    if (blockAssigned[vRoot] === 1) return;
    blockAssigned[vRoot] = 1;

    let isInitialAssignment = true;
    let w = vRoot;
    do {
      const wNode = nodes[w]!;
      const layer = layers[wNode.layer]!;
      const predIdx = dirV === 1 ? wNode.row - 1 : wNode.row + 1;

      if (predIdx >= 0 && predIdx < layer.length) {
        const pred = layer[predIdx]!;
        const predNode = nodes[pred]!;
        const uRoot = root[pred]!;
        placeBlock(uRoot);

        if (sink[vRoot] === vRoot) {
          sink[vRoot] = sink[uRoot]!;
        }

        const gap = getVerticalGap(predNode, wNode, nodeSpacingY);
        const topHeight = dirV === 1 ? predNode.height : wNode.height;
        const requiredDelta =
          (insideShift[pred] ?? 0) + topHeight + gap - (insideShift[w] ?? 0);

        if (sink[vRoot] === sink[uRoot]) {
          const candidate = (blockX[uRoot] ?? 0) + requiredDelta;
          if (isInitialAssignment) {
            blockX[vRoot] = candidate;
            isInitialAssignment = false;
          } else if (candidate > (blockX[vRoot] ?? 0)) {
            blockX[vRoot] = candidate;
          }
        } else {
          crossConstraints.push({
            uBlock: uRoot,
            vBlock: vRoot,
            requiredDelta,
          });
        }
      }

      w = align[w]!;
    } while (w !== vRoot);
  };

  for (let i = 0; i < n; i++) {
    if (root[i] === i) {
      placeBlock(i);
    }
  }

  // Step 4: Topological Class DAG placement (replaces single-pass shift[sink])
  const distinctClasses: number[] = [];
  const classIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (root[i] !== i) continue;
    const s = sink[i]!;
    if (!classIndex.has(s)) {
      classIndex.set(s, distinctClasses.length);
      distinctClasses.push(s);
    }
  }

  const numClasses = distinctClasses.length;
  const classShift = new Float64Array(numClasses);
  const classEdgeMax = Array.from(
    { length: numClasses },
    () => new Map<number, number>(),
  );

  for (const c of crossConstraints) {
    const cu = classIndex.get(sink[c.uBlock]!)!;
    const cv = classIndex.get(sink[c.vBlock]!)!;
    if (cu === cv) continue;
    const weight =
      (blockX[c.uBlock] ?? 0) + c.requiredDelta - (blockX[c.vBlock] ?? 0);
    const existing = classEdgeMax[cu]!.get(cv);
    if (existing === undefined || weight > existing) {
      classEdgeMax[cu]!.set(cv, weight);
    }
  }

  const classInDeg = new Int32Array(numClasses);
  const classInEdges: Array<Array<{ from: number; w: number }>> = Array.from(
    { length: numClasses },
    () => [],
  );
  const classOutEdges: Array<Array<{ to: number; w: number }>> = Array.from(
    { length: numClasses },
    () => [],
  );

  for (let cu = 0; cu < numClasses; cu++) {
    for (const [cv, w] of classEdgeMax[cu]!.entries()) {
      classInDeg[cv] = (classInDeg[cv] ?? 0) + 1;
      classOutEdges[cu]!.push({ to: cv, w });
      classInEdges[cv]!.push({ from: cu, w });
    }
  }

  for (let c = 0; c < numClasses; c++) {
    classShift[c] = (classInDeg[c] ?? 0) === 0 ? 0 : -Infinity;
  }

  const topoOrder: number[] = [];
  const queue: number[] = [];
  const remIn = new Int32Array(classInDeg);
  for (let c = 0; c < numClasses; c++) {
    if (remIn[c] === 0) queue.push(c);
  }
  let qHead = 0;
  while (qHead < queue.length) {
    const c = queue[qHead++]!;
    topoOrder.push(c);
    for (const edge of classOutEdges[c]!) {
      const nextShift = (classShift[c] ?? 0) + edge.w;
      if (nextShift > (classShift[edge.to] ?? -Infinity)) {
        classShift[edge.to] = nextShift;
      }
      const nextRem = (remIn[edge.to] ?? 0) - 1;
      remIn[edge.to] = nextRem;
      if (nextRem === 0) queue.push(edge.to);
    }
  }

  // Fallback only if a non-planar crossing somehow caused a class cycle
  if (topoOrder.length < numClasses) {
    const seen = new Set(topoOrder);
    for (let c = 0; c < numClasses; c++) {
      if (!seen.has(c)) {
        topoOrder.push(c);
        if (!Number.isFinite(classShift[c])) classShift[c] = 0;
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const c of topoOrder) {
        for (const edge of classOutEdges[c]!) {
          const req = (classShift[c] ?? 0) + edge.w;
          if (req > (classShift[edge.to] ?? -Infinity)) {
            classShift[edge.to] = req;
          }
        }
      }
    }
  }

  // Tighten floating source classes cleanly toward their downstream class anchors
  for (let idx = topoOrder.length - 1; idx >= 0; idx--) {
    const c = topoOrder[idx]!;
    if (classInEdges[c]!.length > 0 || classOutEdges[c]!.length === 0) continue;
    let tightUpper = Infinity;
    for (const edge of classOutEdges[c]!) {
      const candidate = (classShift[edge.to] ?? 0) - edge.w;
      if (candidate < tightUpper) tightUpper = candidate;
    }
    if (Number.isFinite(tightUpper) && tightUpper > (classShift[c] ?? 0)) {
      classShift[c] = tightUpper;
    }
  }

  const coords = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = root[i]!;
    const cIdx = classIndex.get(sink[r]!)!;
    const val =
      (blockX[r] ?? 0) + (classShift[cIdx] ?? 0) + (insideShift[i] ?? 0);
    coords[i] = dirV === 1 ? val : -val;
  }

  return coords;
}

function assignVerticalCoordinates(
  graph: ProperGraph,
  nodeSpacingY: number,
): void {
  const { layers, nodes } = graph;
  const n = nodes.length;
  if (n === 0) return;

  const conflicts = markConflicts(graph);
  const passes: Float64Array[] = [
    runBrandesKopfPass(graph, conflicts, 1, 1, nodeSpacingY),
    runBrandesKopfPass(graph, conflicts, 1, -1, nodeSpacingY),
    runBrandesKopfPass(graph, conflicts, -1, 1, nodeSpacingY),
    runBrandesKopfPass(graph, conflicts, -1, -1, nodeSpacingY),
  ];

  const passMin = new Float64Array(4);
  const passMax = new Float64Array(4);
  let minSpanPass = 0;
  let minSpan = Infinity;

  for (let p = 0; p < 4; p++) {
    const coords = passes[p]!;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const top = coords[i] ?? 0;
      const bottom = top + nodes[i]!.height;
      if (top < lo) lo = top;
      if (bottom > hi) hi = bottom;
    }
    passMin[p] = lo;
    passMax[p] = hi;
    const span = hi - lo;
    if (span < minSpan) {
      minSpan = span;
      minSpanPass = p;
    }
  }

  const refMin = passMin[minSpanPass] ?? 0;
  const refMax = passMax[minSpanPass] ?? 0;
  const alignedPasses: Float64Array[] = [];

  for (let p = 0; p < 4; p++) {
    const coords = passes[p]!;
    const isBottomBiased = p === 1 || p === 3;
    const shift = isBottomBiased
      ? refMax - (passMax[p] ?? 0)
      : refMin - (passMin[p] ?? 0);
    const shifted = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      shifted[i] = (coords[i] ?? 0) + shift;
    }
    alignedPasses.push(shifted);
  }

  const ys = new Float64Array(n);
  const tuple: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    tuple[0] = alignedPasses[0]![i] ?? 0;
    tuple[1] = alignedPasses[1]![i] ?? 0;
    tuple[2] = alignedPasses[2]![i] ?? 0;
    tuple[3] = alignedPasses[3]![i] ?? 0;
    tuple.sort((a, b) => a - b);
    ys[i] = (tuple[1] + tuple[2]) / 2;
  }

  // Non-overlap constraint verification fallback per layer
  for (const layer of layers) {
    for (let r = 1; r < layer.length; r++) {
      const prevIdx = layer[r - 1]!;
      const currIdx = layer[r]!;
      const prevNode = nodes[prevIdx]!;
      const currNode = nodes[currIdx]!;
      const minAllowed =
        (ys[prevIdx] ?? 0) +
        prevNode.height +
        getVerticalGap(prevNode, currNode, nodeSpacingY);
      if ((ys[currIdx] ?? 0) < minAllowed) {
        ys[currIdx] = minAllowed;
      }
    }
  }

  let globalMinY = Infinity;
  for (let i = 0; i < n; i++) {
    if ((ys[i] ?? 0) < globalMinY) globalMinY = ys[i] ?? 0;
  }
  for (let i = 0; i < n; i++) {
    nodes[i]!.y = Math.round((ys[i] ?? 0) - globalMinY);
  }
}

// ============================================================================
// Phase 6: Sander Orthogonal Channel Router + Bus Trunks + Back-Loop Routing
// ============================================================================

interface HyperSegment {
  readonly id: number;
  readonly gutter: number;
  readonly busGroupKey: string | null;
  readonly isBus: boolean;
  readonly sourceLocal: number;
  readonly memberSegLinks: SegmentLink[];
  readonly incomingYs: number[];
  readonly outgoingYs: number[];
  readonly yMin: number;
  readonly yMax: number;
  readonly isHorizontalOnly: boolean;
  readonly splitNextId: number; // for split right-half constraint
  readonly ySplit: number | null;
  readonly pairKeyId: string;
}

interface GutterRoutingPlan {
  readonly gutter: number;
  readonly width: number;
  readonly slotCount: number;
  readonly slotOfSegment: Map<
    string,
    {
      readonly slot: number;
      readonly splitSlot?: number;
      readonly ySplit?: number;
    }
  >;
  readonly busGroups: Array<{
    readonly busGroupKey: string;
    readonly sourceLocal: number;
    readonly srcPortY: number;
    readonly slot: number;
    readonly targetPortYs: number[];
    readonly edgeIndices: number[];
  }>;
  readonly srcPortYs: Map<number, number>; // segIndex -> portY
  readonly dstPortYs: Map<number, number>;
}

function distributePorts(
  node: WorkingNode,
  sortedItems: ReadonlyArray<{
    readonly key: number;
    readonly sortCoord: number;
  }>,
): Map<number, number> {
  const result = new Map<number, number>();
  const count = sortedItems.length;
  if (count === 0) return result;
  const centerY = node.y + node.height / 2;
  if (count === 1) {
    result.set(sortedItems[0]!.key, Math.round(centerY));
    return result;
  }

  const maxSpread = Math.max(8, Math.min(34, node.height - 20));
  const step = Math.min(8, maxSpread / (count - 1));
  const totalSpread = step * (count - 1);
  const startY = centerY - totalSpread / 2;

  for (let i = 0; i < count; i++) {
    result.set(sortedItems[i]!.key, Math.round(startY + i * step));
  }
  return result;
}

function routeGutterChannels(
  graph: ProperGraph,
  workingEdges: ReadonlyArray<WorkingEdge>,
  opts: ResolvedOptions,
  backLoopExitCountByLayer: Int32Array,
  backLoopEntryCountByLayer: Int32Array,
): GutterRoutingPlan[] {
  const { layers, nodes, segsByGutter } = graph;
  const plans: GutterRoutingPlan[] = [];

  for (let g = 0; g < segsByGutter.length; g++) {
    const segs = segsByGutter[g]!;
    const srcPortYs = new Map<number, number>();
    const dstPortYs = new Map<number, number>();

    // Determine bus groups in this gutter (fanOut >= busThreshold)
    const busBuckets = new Map<string, number[]>();
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      const key = s.busGroupKey ?? `__auto_src:${s.srcLocal}`;
      const list = busBuckets.get(key);
      if (list) list.push(i);
      else busBuckets.set(key, [i]);
    }

    const busKeyOfSegIdx = new Map<number, string>();
    for (const [key, indices] of busBuckets.entries()) {
      if (indices.length >= opts.busThreshold) {
        // Ensure all members share same source node
        const bySrc = new Map<number, number[]>();
        for (const idx of indices) {
          const src = segs[idx]!.srcLocal;
          const sub = bySrc.get(src);
          if (sub) sub.push(idx);
          else bySrc.set(src, [idx]);
        }
        for (const [src, subIndices] of bySrc.entries()) {
          if (subIndices.length >= opts.busThreshold) {
            const concreteKey = `${key}#${src}`;
            for (const idx of subIndices) {
              busKeyOfSegIdx.set(idx, concreteKey);
            }
          }
        }
      }
    }

    // Free port ordering on source (left) and target (right) layers
    const outByNode = new Map<number, number[]>();
    const inByNode = new Map<number, number[]>();
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      const ol = outByNode.get(s.srcLocal);
      if (ol) ol.push(i);
      else outByNode.set(s.srcLocal, [i]);
      const il = inByNode.get(s.dstLocal);
      if (il) il.push(i);
      else inByNode.set(s.dstLocal, [i]);
    }

    for (const [srcLocal, indices] of outByNode.entries()) {
      const srcNode = nodes[srcLocal]!;
      // Bus members share a single port at center (or one slot in sorted order)
      const busGroupsSeen = new Map<string, number[]>();
      const nonBus: number[] = [];
      for (const idx of indices) {
        const bk = busKeyOfSegIdx.get(idx);
        if (bk) {
          const list = busGroupsSeen.get(bk);
          if (list) list.push(idx);
          else busGroupsSeen.set(bk, [idx]);
        } else {
          nonBus.push(idx);
        }
      }

      if (
        busGroupsSeen.size > 0 &&
        nonBus.length === 0 &&
        busGroupsSeen.size === 1
      ) {
        const centerY = Math.round(srcNode.y + srcNode.height / 2);
        for (const idx of indices) srcPortYs.set(idx, centerY);
      } else {
        const items: Array<{ key: number; sortCoord: number }> = [];
        for (const idx of nonBus) {
          const dst = nodes[segs[idx]!.dstLocal]!;
          items.push({ key: idx, sortCoord: dst.y + dst.height / 2 });
        }
        let syntheticKey = -1;
        const syntheticMembers = new Map<number, number[]>();
        for (const groupIndices of busGroupsSeen.values()) {
          let avgY = 0;
          for (const idx of groupIndices) {
            const dst = nodes[segs[idx]!.dstLocal]!;
            avgY += dst.y + dst.height / 2;
          }
          avgY /= groupIndices.length;
          const k = syntheticKey--;
          syntheticMembers.set(k, groupIndices);
          items.push({ key: k, sortCoord: avgY });
        }
        items.sort((a, b) => a.sortCoord - b.sortCoord || a.key - b.key);
        const mapped = distributePorts(srcNode, items);
        for (const [k, py] of mapped.entries()) {
          if (k >= 0) {
            srcPortYs.set(k, py);
          } else {
            for (const idx of syntheticMembers.get(k)!) {
              srcPortYs.set(idx, py);
            }
          }
        }
      }
    }

    for (const [dstLocal, indices] of inByNode.entries()) {
      const dstNode = nodes[dstLocal]!;
      const items = indices
        .map((idx) => {
          const src = nodes[segs[idx]!.srcLocal]!;
          return { key: idx, sortCoord: src.y + src.height / 2 };
        })
        .toSorted((a, b) => a.sortCoord - b.sortCoord || a.key - b.key);
      const mapped = distributePorts(dstNode, items);
      for (const [idx, py] of mapped.entries()) {
        dstPortYs.set(idx, py);
      }
    }

    // Build HyperEdgeSegments
    const hyperSegs: HyperSegment[] = [];
    const groupedByBus = new Map<string, number[]>();
    const unbundled: number[] = [];

    for (let i = 0; i < segs.length; i++) {
      const bk = busKeyOfSegIdx.get(i);
      if (bk) {
        const list = groupedByBus.get(bk);
        if (list) list.push(i);
        else groupedByBus.set(bk, [i]);
      } else {
        unbundled.push(i);
      }
    }

    for (const [bk, indices] of groupedByBus.entries()) {
      const inYs: number[] = [];
      const outYs: number[] = [];
      const memberLinks: SegmentLink[] = [];
      let yMin = Infinity;
      let yMax = -Infinity;
      for (const idx of indices) {
        const pyIn = srcPortYs.get(idx)!;
        const pyOut = dstPortYs.get(idx)!;
        inYs.push(pyIn);
        outYs.push(pyOut);
        memberLinks.push(segs[idx]!);
        yMin = Math.min(yMin, pyIn, pyOut);
        yMax = Math.max(yMax, pyIn, pyOut);
      }
      hyperSegs.push({
        id: hyperSegs.length,
        gutter: g,
        busGroupKey: bk,
        isBus: true,
        sourceLocal: segs[indices[0]!]!.srcLocal,
        memberSegLinks: memberLinks,
        incomingYs: inYs,
        outgoingYs: outYs,
        yMin,
        yMax,
        isHorizontalOnly: yMax - yMin < 1,
        splitNextId: -1,
        ySplit: null,
        pairKeyId: `bus:${bk}`,
      });
    }

    for (const idx of unbundled) {
      const s = segs[idx]!;
      const pyIn = srcPortYs.get(idx)!;
      const pyOut = dstPortYs.get(idx)!;
      const yMin = Math.min(pyIn, pyOut);
      const yMax = Math.max(pyIn, pyOut);
      hyperSegs.push({
        id: hyperSegs.length,
        gutter: g,
        busGroupKey: null,
        isBus: false,
        sourceLocal: s.srcLocal,
        memberSegLinks: [s],
        incomingYs: [pyIn],
        outgoingYs: [pyOut],
        yMin,
        yMax,
        isHorizontalOnly: yMax - yMin < 1,
        splitNextId: -1,
        ySplit: null,
        pairKeyId: `seg:${s.edgeIdx}:${s.srcLocal}->${s.dstLocal}`,
      });
    }

    // Build dependency constraints among non-horizontal segments + HyperEdgeSegmentSplitter
    const activeSegs: HyperSegment[] = [...hyperSegs];
    const verticalIndices = (): number[] =>
      activeSegs
        .map((s, idx) => (!s.isHorizontalOnly ? idx : -1))
        .filter((idx) => idx >= 0);

    const buildConflicts = (indices: ReadonlyArray<number>) => {
      const edgesMap = new Map<string, number>();
      const addEdge = (a: number, b: number, w: number) => {
        if (a === b) return;
        const key = `${a}->${b}`;
        edgesMap.set(key, (edgesMap.get(key) ?? 0) + w);
      };

      for (let i = 0; i < indices.length; i++) {
        const aIdx = indices[i]!;
        const a = activeSegs[aIdx]!;
        for (let j = i + 1; j < indices.length; j++) {
          const bIdx = indices[j]!;
          const b = activeSegs[bIdx]!;

          if (a.splitNextId === b.id) {
            addEdge(aIdx, bIdx, 100);
            continue;
          }
          if (b.splitNextId === a.id) {
            addEdge(bIdx, aIdx, 100);
            continue;
          }

          if (a.yMax + 1 < b.yMin || b.yMax + 1 < a.yMin) continue;

          // If a's incoming stub lies inside b's vertical span, a must be LEFT of b
          for (const yIn of a.incomingYs) {
            if (yIn >= b.yMin - 1 && yIn <= b.yMax + 1) {
              addEdge(aIdx, bIdx, 2);
            }
          }
          for (const yOut of b.outgoingYs) {
            if (yOut >= a.yMin - 1 && yOut <= a.yMax + 1) {
              addEdge(aIdx, bIdx, 2);
            }
          }
          for (const yIn of b.incomingYs) {
            if (yIn >= a.yMin - 1 && yIn <= a.yMax + 1) {
              addEdge(bIdx, aIdx, 2);
            }
          }
          for (const yOut of a.outgoingYs) {
            if (yOut >= b.yMin - 1 && yOut <= b.yMax + 1) {
              addEdge(bIdx, aIdx, 2);
            }
          }
        }
      }
      return edgesMap;
    };

    // HyperEdgeSegmentSplitter: break critical 2-cycles by splitting one non-bus segment
    let deps = buildConflicts(verticalIndices());
    const alreadySplit = new Set<number>();
    const maxSplits = Math.min(16, activeSegs.length);
    for (let splitPass = 0; splitPass < maxSplits; splitPass++) {
      let cyclePair: [number, number] | null = null;
      const vIds = verticalIndices();
      for (let i = 0; i < vIds.length && !cyclePair; i++) {
        for (let j = i + 1; j < vIds.length; j++) {
          const a = vIds[i]!;
          const b = vIds[j]!;
          if (deps.has(`${a}->${b}`) && deps.has(`${b}->${a}`)) {
            cyclePair = [a, b];
            break;
          }
        }
      }
      if (!cyclePair) break;

      const [aIdx, bIdx] = cyclePair;
      const candA = activeSegs[aIdx]!;
      const candB = activeSegs[bIdx]!;
      const targetIdx =
        !candA.isBus && !alreadySplit.has(aIdx)
          ? aIdx
          : !candB.isBus && !alreadySplit.has(bIdx)
            ? bIdx
            : -1;
      if (targetIdx === -1) break;

      const seg = activeSegs[targetIdx]!;
      const yIn = seg.incomingYs[0]!;
      const yOut = seg.outgoingYs[0]!;
      const loY = Math.min(yIn, yOut);
      const hiY = Math.max(yIn, yOut);

      // Pick a free-area gap midpoint in left/right layer if available, else exact midpoint
      let ySplit = Math.round((yIn + yOut) / 2);
      const candidateGaps: number[] = [];
      for (const layerNodes of [layers[g]!, layers[g + 1]!]) {
        for (let r = 0; r < layerNodes.length - 1; r++) {
          const nTop = nodes[layerNodes[r]!]!;
          const nBot = nodes[layerNodes[r + 1]!]!;
          const gapMid = Math.round((nTop.y + nTop.height + nBot.y) / 2);
          if (gapMid > loY + 10 && gapMid < hiY - 10) {
            candidateGaps.push(gapMid);
          }
        }
      }
      if (candidateGaps.length > 0) {
        const ideal = (yIn + yOut) / 2;
        candidateGaps.sort((p, q) => Math.abs(p - ideal) - Math.abs(q - ideal));
        ySplit = candidateGaps[0]!;
      }

      const rightId = activeSegs.length;
      const leftMin = Math.min(yIn, ySplit);
      const leftMax = Math.max(yIn, ySplit);
      const rightMin = Math.min(ySplit, yOut);
      const rightMax = Math.max(ySplit, yOut);

      activeSegs[targetIdx] = {
        ...seg,
        outgoingYs: [],
        yMin: leftMin,
        yMax: leftMax,
        isHorizontalOnly: leftMax - leftMin < 1,
        splitNextId: rightId,
        ySplit,
      };
      activeSegs.push({
        id: rightId,
        gutter: g,
        busGroupKey: null,
        isBus: false,
        sourceLocal: seg.sourceLocal,
        memberSegLinks: seg.memberSegLinks,
        incomingYs: [],
        outgoingYs: [yOut],
        yMin: rightMin,
        yMax: rightMax,
        isHorizontalOnly: rightMax - rightMin < 1,
        splitNextId: -1,
        ySplit,
        pairKeyId: `${seg.pairKeyId}:splitR`,
      });
      alreadySplit.add(targetIdx);
      alreadySplit.add(rightId);
      deps = buildConflicts(verticalIndices());
    }

    // Break any remaining soft cycles using deterministic greedy ordering + 2-pass slot assignment
    const vSegs = verticalIndices();
    const depOut = new Map<number, number[]>();
    const depInDeg = new Map<number, number>();
    for (const id of vSegs) {
      depOut.set(id, []);
      depInDeg.set(id, 0);
    }

    for (const [key] of deps.entries()) {
      const [fromStr, toStr] = key.split("->");
      const from = Number(fromStr);
      const to = Number(toStr);
      // Skip explicit reverse edges in soft 2-cycles that couldn't split
      if (deps.has(`${to}->${from}`) && from > to) continue;
      depOut.get(from)!.push(to);
      depInDeg.set(to, (depInDeg.get(to) ?? 0) + 1);
    }

    // Topological slot numbering with greedy cycle breaking if larger cycles remain
    const slotNum = new Map<number, number>();
    const remainingIds = new Set(vSegs);
    const activeInDeg = new Map(depInDeg);
    const orderedVSegs: number[] = [];

    while (remainingIds.size > 0) {
      const ready: number[] = [];
      for (const id of remainingIds) {
        if ((activeInDeg.get(id) ?? 0) === 0) ready.push(id);
      }
      ready.sort((a, b) => a - b);

      let chosen: number;
      if (ready.length > 0) {
        chosen = ready[0]!;
      } else {
        // Break soft cycle by picking node with smallest inDeg then largest outDeg
        const candidates = [...remainingIds].toSorted((a, b) => {
          const inDiff = (activeInDeg.get(a) ?? 0) - (activeInDeg.get(b) ?? 0);
          if (inDiff !== 0) return inDiff;
          return (depOut.get(b)?.length ?? 0) - (depOut.get(a)?.length ?? 0);
        });
        chosen = candidates[0]!;
      }

      remainingIds.delete(chosen);
      orderedVSegs.push(chosen);
      for (const next of depOut.get(chosen) ?? []) {
        if (remainingIds.has(next)) {
          activeInDeg.set(next, Math.max(0, (activeInDeg.get(next) ?? 0) - 1));
        }
      }
    }

    // Pass 1: Forward longest path
    const dagChildren = new Map<number, number[]>();
    const dagParents = new Map<number, number[]>();
    const orderRank = new Map<number, number>();
    for (let i = 0; i < orderedVSegs.length; i++) {
      const id = orderedVSegs[i]!;
      orderRank.set(id, i);
      dagChildren.set(id, []);
      dagParents.set(id, []);
      slotNum.set(id, 0);
    }
    for (const u of orderedVSegs) {
      for (const v of depOut.get(u) ?? []) {
        if ((orderRank.get(u) ?? 0) < (orderRank.get(v) ?? 0)) {
          dagChildren.get(u)!.push(v);
          dagParents.get(v)!.push(u);
          const nextSlot = (slotNum.get(u) ?? 0) + 1;
          if (nextSlot > (slotNum.get(v) ?? 0)) {
            slotNum.set(v, nextSlot);
          }
        }
      }
    }

    // Pass 2: Rightward balancing for segments with free slack
    let maxSlot = 0;
    for (const s of slotNum.values()) {
      if (s > maxSlot) maxSlot = s;
    }
    for (let i = orderedVSegs.length - 1; i >= 0; i--) {
      const u = orderedVSegs[i]!;
      const children = dagChildren.get(u)!;
      const parents = dagParents.get(u)!;
      if (children.length === 0 && parents.length > 0 && activeSegs[u]!.isBus) {
        slotNum.set(u, maxSlot);
      } else if (children.length > 0) {
        let minChildSlot = maxSlot + 1;
        for (const v of children) {
          const cs = slotNum.get(v) ?? 0;
          if (cs < minChildSlot) minChildSlot = cs;
        }
        const cur = slotNum.get(u) ?? 0;
        if (parents.length === 0 && minChildSlot - 1 > cur) {
          slotNum.set(u, minChildSlot - 1);
        }
      }
    }

    const slotOfSegment = new Map<
      string,
      {
        readonly slot: number;
        readonly splitSlot?: number;
        readonly ySplit?: number;
      }
    >();
    const busGroups: GutterRoutingPlan["busGroups"] = [];

    for (const seg of activeSegs) {
      if (seg.pairKeyId.endsWith(":splitR")) continue;
      if (seg.splitNextId !== -1) {
        const rightSeg = activeSegs[seg.splitNextId]!;
        slotOfSegment.set(seg.pairKeyId, {
          slot: slotNum.get(seg.id) ?? 0,
          splitSlot: slotNum.get(rightSeg.id) ?? 1,
          ...(seg.ySplit !== null ? { ySplit: seg.ySplit } : {}),
        });
      } else {
        slotOfSegment.set(seg.pairKeyId, {
          slot: seg.isHorizontalOnly ? 0 : (slotNum.get(seg.id) ?? 0),
        });
      }

      if (seg.isBus && seg.busGroupKey) {
        busGroups.push({
          busGroupKey: seg.busGroupKey,
          sourceLocal: seg.sourceLocal,
          srcPortY: seg.incomingYs[0]!,
          slot: seg.isHorizontalOnly ? 0 : (slotNum.get(seg.id) ?? 0),
          targetPortYs: seg.outgoingYs,
          edgeIndices: seg.memberSegLinks.map((m) => m.edgeIdx),
        });
      }
    }

    let maxSpan1LabelWidth = 0;
    for (const s of segs) {
      const we = workingEdges[s.edgeIdx]!;
      if (we.origSrcLocal === s.srcLocal && we.origDstLocal === s.dstLocal) {
        const lw = we.input.labelWidth ?? 0;
        if (lw > maxSpan1LabelWidth) maxSpan1LabelWidth = lw;
      }
    }

    const leftBackLoopZone =
      (backLoopExitCountByLayer[g] ?? 0) > 0
        ? 18 + (backLoopExitCountByLayer[g] ?? 0) * 12
        : 12;
    const rightBackLoopZone =
      (backLoopEntryCountByLayer[g + 1] ?? 0) > 0
        ? 18 + (backLoopEntryCountByLayer[g + 1] ?? 0) * 12
        : 12;
    const slotCount = vSegs.length === 0 ? 0 : maxSlot + 1;
    const channelNeed =
      leftBackLoopZone +
      Math.max(1, slotCount) * opts.channelSpacing +
      rightBackLoopZone;
    const labelNeed = maxSpan1LabelWidth > 0 ? maxSpan1LabelWidth + 32 : 0;
    const gutterWidth = Math.max(opts.minLayerGap, channelNeed, labelNeed);

    plans.push({
      gutter: g,
      width: gutterWidth,
      slotCount,
      slotOfSegment,
      busGroups,
      srcPortYs,
      dstPortYs,
    });
  }

  return plans;
}

function buildRoundedOrthogonalPath(
  rawPoints: ReadonlyArray<LayoutPoint>,
  cornerRadius: number,
): { readonly points: ReadonlyArray<LayoutPoint>; readonly path: string } {
  if (rawPoints.length === 0) return { points: [], path: "" };
  if (rawPoints.length === 1) {
    const p = rawPoints[0]!;
    return { points: [p], path: `M ${p.x} ${p.y}` };
  }

  // Deduplicate consecutive identical points & merge collinear points
  const deduped: LayoutPoint[] = [];
  for (const pt of rawPoints) {
    const last = deduped[deduped.length - 1];
    if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.5) continue;
    deduped.push({
      x: Math.round(pt.x * 10) / 10,
      y: Math.round(pt.y * 10) / 10,
    });
  }

  const points: LayoutPoint[] = [];
  for (const pt of deduped) {
    while (points.length >= 2) {
      const a = points[points.length - 2]!;
      const b = points[points.length - 1]!;
      const sameX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - pt.x) < 0.5;
      const sameY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - pt.y) < 0.5;
      if (sameX || sameY) {
        points.pop();
      } else {
        break;
      }
    }
    points.push(pt);
  }

  if (points.length < 2) {
    const p = points[0] ?? rawPoints[0]!;
    return { points: [p], path: `M ${p.x} ${p.y}` };
  }

  const parts: string[] = [`M ${points[0]!.x} ${points[0]!.y}`];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const next = points[i + 1]!;

    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const d1 = Math.hypot(dx1, dy1);

    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;
    const d2 = Math.hypot(dx2, dy2);

    const r = Math.min(cornerRadius, d1 * 0.45, d2 * 0.45);
    if (r < 0.75 || d1 < 1 || d2 < 1) {
      parts.push(`L ${curr.x} ${curr.y}`);
      continue;
    }

    const ux1 = dx1 / d1;
    const uy1 = dy1 / d1;
    const ux2 = dx2 / d2;
    const uy2 = dy2 / d2;

    const ex = Math.round((curr.x - ux1 * r) * 10) / 10;
    const ey = Math.round((curr.y - uy1 * r) * 10) / 10;
    const sx = Math.round((curr.x + ux2 * r) * 10) / 10;
    const sy = Math.round((curr.y + uy2 * r) * 10) / 10;

    parts.push(`L ${ex} ${ey} Q ${curr.x} ${curr.y} ${sx} ${sy}`);
  }

  const last = points[points.length - 1]!;
  parts.push(`L ${last.x} ${last.y}`);
  return { points, path: parts.join(" ") };
}

function chooseCollisionFreeLabelAnchor(
  candidates: ReadonlyArray<LayoutPoint>,
  labelWidth: number,
  labelHeight: number,
  nodeRects: ReadonlyArray<Rect>,
  placedLabels: Rect[],
): LayoutPoint {
  const effectiveW = Math.max(32, labelWidth);
  const effectiveH = Math.max(14, labelHeight);

  let bestPoint = candidates[0] ?? { x: 0, y: 0 };
  let bestPenalty = Infinity;

  for (let idx = 0; idx < candidates.length; idx++) {
    const cand = candidates[idx]!;
    const box: Rect = {
      x: cand.x - effectiveW / 2 - 4,
      y: cand.y - effectiveH / 2 - 3,
      width: effectiveW + 8,
      height: effectiveH + 6,
    };

    let penalty = idx * 0.05;
    for (const nr of nodeRects) {
      if (rectsOverlap(box, nr, 4)) {
        penalty += 10_000 + rectOverlapArea(box, nr);
      }
    }
    for (const lr of placedLabels) {
      if (rectsOverlap(box, lr, 2)) {
        penalty += 500 + rectOverlapArea(box, lr);
      }
    }

    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestPoint = cand;
      if (penalty < 0.06) break;
    }
  }

  placedLabels.push({
    x: bestPoint.x - effectiveW / 2 - 4,
    y: bestPoint.y - effectiveH / 2 - 3,
    width: effectiveW + 8,
    height: effectiveH + 6,
  });

  return { x: Math.round(bestPoint.x), y: Math.round(bestPoint.y) };
}

// ============================================================================
// Component Driver & Main Entry Point
// ============================================================================

interface ComponentLayoutOutput {
  readonly nodes: PositionedLayoutNode[];
  readonly edges: RoutedLayoutEdge[];
  readonly busTrunks: BusTrunkSegment[];
  readonly junctions: BusJunctionPoint[];
  readonly width: number;
  readonly height: number;
  readonly maxLayerCount: number;
}

function layoutActiveComponent(
  comp: RawComponent,
  componentIndex: number,
  topOffsetY: number,
  opts: ResolvedOptions,
): ComponentLayoutOutput {
  const localIndexById = new Map<number, number>();
  for (let i = 0; i < comp.nodes.length; i++) {
    localIndexById.set(comp.nodes[i]!.id, i);
  }

  // Phase 2: Cycle removal on non-feedback edges
  const fasCandidates: Array<{
    readonly srcLocal: number;
    readonly dstLocal: number;
    readonly priority: number;
  }> = [];

  for (const e of comp.edges) {
    if (e.isFeedbackHint) continue;
    fasCandidates.push({
      srcLocal: localIndexById.get(e.sourceId)!,
      dstLocal: localIndexById.get(e.targetId)!,
      priority: e.priority ?? 1,
    });
  }

  const fasOrder = computeGreedyFasOrder(comp.nodes, fasCandidates);

  const workingEdges: WorkingEdge[] = [];
  for (let i = 0; i < comp.edges.length; i++) {
    const e = comp.edges[i]!;
    const origSrcLocal = localIndexById.get(e.sourceId)!;
    const origDstLocal = localIndexById.get(e.targetId)!;
    const isHintFeedback = Boolean(e.isFeedbackHint);
    const reversedByFas =
      !isHintFeedback &&
      (fasOrder[origSrcLocal] ?? 0) > (fasOrder[origDstLocal] ?? 0);

    workingEdges.push({
      inputIdx: i,
      input: e,
      origSrcLocal,
      origDstLocal,
      dagSrcLocal: reversedByFas ? origDstLocal : origSrcLocal,
      dagDstLocal: reversedByFas ? origSrcLocal : origDstLocal,
      reversed: reversedByFas,
      isFeedback: isHintFeedback || reversedByFas,
      priority: e.priority ?? 1,
      weight: Math.max(1, e.weight ?? 1),
      minSpan: Math.max(1, e.minSpan ?? 1),
    });
  }

  // Phase 3: Network Simplex rank assignment + balancing + owner grouping
  const ranks = assignRanks(comp.nodes, workingEdges, localIndexById);

  // Phase 4: Proper layering + crossing reduction
  const graph = buildProperGraph(comp.nodes, workingEdges, ranks);
  reduceCrossings(graph, opts.maxBarycenterSweeps);

  // Phase 5: 4-pass Brandes–Köpf + 2020 Erratum
  assignVerticalCoordinates(graph, opts.nodeSpacingY);

  // Compute component vertical bounds before back-loop corridor allocation
  let compMaxBottom = 0;
  for (const node of graph.nodes) {
    if (!node.isDummy) {
      const bottom = node.y + node.height;
      if (bottom > compMaxBottom) compMaxBottom = bottom;
    }
  }
  const compCenterY = compMaxBottom / 2;

  // Partition back-loop edges into top vs bottom corridors and count per-column lane needs
  const backLoopIndices: number[] = [];
  const backLoopCorridor = new Map<number, "top" | "bottom">();
  const backLoopExitCountByLayer = new Int32Array(graph.layers.length);
  const backLoopEntryCountByLayer = new Int32Array(graph.layers.length);
  let topLaneCount = 0;
  let bottomLaneCount = 0;

  for (let i = 0; i < workingEdges.length; i++) {
    const we = workingEdges[i]!;
    if (!we.isFeedback) continue;
    backLoopIndices.push(i);
    const srcNode = graph.nodes[we.origSrcLocal]!;
    const dstNode = graph.nodes[we.origDstLocal]!;
    const srcCy = srcNode.y + srcNode.height / 2;
    const dstCy = dstNode.y + dstNode.height / 2;
    const avgCy = (srcCy + dstCy) / 2;

    // Route strictly upper-half non-hint back-loops via top corridor when appropriate,
    // while keeping centered or event-emit loops along the bottom corridor
    const useTop =
      !we.input.isFeedbackHint &&
      avgCy < compCenterY - 16 &&
      compMaxBottom > 120;
    if (useTop) {
      backLoopCorridor.set(i, "top");
      topLaneCount++;
    } else {
      backLoopCorridor.set(i, "bottom");
      bottomLaneCount++;
    }

    backLoopExitCountByLayer[srcNode.layer] =
      (backLoopExitCountByLayer[srcNode.layer] ?? 0) + 1;
    backLoopEntryCountByLayer[dstNode.layer] =
      (backLoopEntryCountByLayer[dstNode.layer] ?? 0) + 1;
  }

  // Reserve top corridor space above component if any top back-loops exist
  const topCorridorHeight =
    topLaneCount > 0
      ? opts.backLoopMargin + topLaneCount * opts.backLoopLaneSpacing
      : 0;
  const nodeBaseY = topOffsetY + topCorridorHeight;
  for (const node of graph.nodes) {
    node.y += nodeBaseY;
  }

  // Phase 6A: Sander channel routing
  const gutterPlans = routeGutterChannels(
    graph,
    workingEdges,
    opts,
    backLoopExitCountByLayer,
    backLoopEntryCountByLayer,
  );

  // Compute adaptive column widths & X coordinates
  const numLayers = graph.layers.length;
  const colWidth = new Float64Array(numLayers);
  for (let l = 0; l < numLayers; l++) {
    let maxRealW = 0;
    let maxAnyW = 0;
    for (const localIdx of graph.layers[l]!) {
      const wn = graph.nodes[localIdx]!;
      if (!wn.isDummy && wn.width > maxRealW) maxRealW = wn.width;
      if (wn.width > maxAnyW) maxAnyW = wn.width;
    }
    colWidth[l] = maxRealW > 0 ? maxRealW : maxAnyW;
  }

  const leftBackLoopOverhang =
    (backLoopEntryCountByLayer[0] ?? 0) > 0
      ? 20 + (backLoopEntryCountByLayer[0] ?? 0) * 12
      : 0;
  const colX = new Float64Array(numLayers);
  colX[0] = opts.padding + leftBackLoopOverhang;
  for (let l = 1; l < numLayers; l++) {
    colX[l] =
      (colX[l - 1] ?? 0) +
      (colWidth[l - 1] ?? 0) +
      (gutterPlans[l - 1]?.width ?? opts.minLayerGap);
  }

  for (let l = 0; l < numLayers; l++) {
    const cw = colWidth[l] ?? 0;
    const cx = colX[l] ?? 0;
    for (const localIdx of graph.layers[l]!) {
      const wn = graph.nodes[localIdx]!;
      wn.x = Math.round(
        wn.isDummy || !opts.uniformColumnWidth ? cx + (cw - wn.width) / 2 : cx,
      );
    }
  }

  const getActualWidth = (wn: WorkingNode): number =>
    !wn.isDummy && opts.uniformColumnWidth
      ? Math.round(colWidth[wn.layer] ?? wn.width)
      : wn.width;

  const slotXInGutter = (g: number, slot: number): number => {
    const plan = gutterPlans[g]!;
    const gutterLeft = (colX[g] ?? 0) + (colWidth[g] ?? 0);
    const leftZone =
      (backLoopExitCountByLayer[g] ?? 0) > 0
        ? 18 + (backLoopExitCountByLayer[g] ?? 0) * 12
        : 12;
    const rightZone =
      (backLoopEntryCountByLayer[g + 1] ?? 0) > 0
        ? 18 + (backLoopEntryCountByLayer[g + 1] ?? 0) * 12
        : 12;
    const availInner = Math.max(0, plan.width - leftZone - rightZone);
    const totalUsed = Math.max(0, plan.slotCount - 1) * opts.channelSpacing;
    const startX = gutterLeft + leftZone + (availInner - totalUsed) / 2;
    return Math.round(startX + slot * opts.channelSpacing);
  };

  // Emit positioned real nodes and build obstacle rect list
  const positionedNodes: PositionedLayoutNode[] = [];
  const nodeRects: Rect[] = [];
  let maxRight = opts.padding;
  let maxBottom = nodeBaseY + compMaxBottom;

  for (let i = 0; i < comp.nodes.length; i++) {
    const wn = graph.nodes[i]!;
    const actualW = getActualWidth(wn);
    const pos: PositionedLayoutNode = {
      id: wn.id,
      layer: wn.layer,
      row: wn.row,
      x: wn.x,
      y: wn.y,
      width: actualW,
      height: wn.height,
      componentIndex,
      isIsolated: false,
    };
    positionedNodes.push(pos);
    nodeRects.push({
      x: pos.x,
      y: pos.y,
      width: pos.width,
      height: pos.height,
    });
    if (pos.x + pos.width > maxRight) maxRight = pos.x + pos.width;
    if (pos.y + pos.height > maxBottom) maxBottom = pos.y + pos.height;
  }

  // Emit deduplicated BusTrunks & BusJunctionPoints
  const busTrunks: BusTrunkSegment[] = [];
  const junctions: BusJunctionPoint[] = [];
  const junctionDedup = new Set<string>();

  for (const plan of gutterPlans) {
    for (const bg of plan.busGroups) {
      const trunkX = slotXInGutter(plan.gutter, bg.slot);
      const srcNode = graph.nodes[bg.sourceLocal]!;
      const srcX = srcNode.x + getActualWidth(srcNode);
      const cleanKey = bg.busGroupKey.replace(/#\d+$/, "");
      const ys = [bg.srcPortY, ...bg.targetPortYs];
      const yStart = Math.min(...ys);
      const yEnd = Math.max(...ys);

      const trunkPolyline: LayoutPoint[] = [
        { x: srcX, y: bg.srcPortY },
        { x: trunkX, y: bg.srcPortY },
        { x: trunkX, y: yStart },
        { x: trunkX, y: yEnd },
      ];
      const roundedTrunk = buildRoundedOrthogonalPath(
        trunkPolyline,
        opts.cornerRadius,
      );

      busTrunks.push({
        busGroupKey: cleanKey,
        layerIndex: plan.gutter,
        sourceId: srcNode.id,
        x: trunkX,
        yStart,
        yEnd,
        path: roundedTrunk.path,
        memberEdgeIds: bg.edgeIndices.map((ei) => workingEdges[ei]!.input.id),
      });

      const addJunction = (jy: number) => {
        const jKey = `${cleanKey}:${trunkX}:${jy}`;
        if (junctionDedup.has(jKey)) return;
        junctionDedup.add(jKey);
        junctions.push({ busGroupKey: cleanKey, x: trunkX, y: jy });
      };
      addJunction(bg.srcPortY);
      for (const ty of bg.targetPortYs) {
        addJunction(ty);
      }
    }
  }

  // Phase 6B: Route all edges (forward orthogonal + back-loop) + label collision check
  const placedLabels: Rect[] = [];
  const routedEdges: RoutedLayoutEdge[] = [];

  // Map segmentIndex per gutter so we can look up exact portYs
  const segIndexByGutterAndEdge = new Map<string, number>();
  for (let g = 0; g < graph.segsByGutter.length; g++) {
    const segs = graph.segsByGutter[g]!;
    for (let sIdx = 0; sIdx < segs.length; sIdx++) {
      const seg = segs[sIdx]!;
      segIndexByGutterAndEdge.set(
        `${g}:${seg.edgeIdx}:${seg.srcLocal}->${seg.dstLocal}`,
        sIdx,
      );
    }
  }

  let topLaneCursor = 0;
  let bottomLaneCursor = 0;
  const exitOffsetByLayer = new Int32Array(numLayers);
  const entryOffsetByLayer = new Int32Array(numLayers);

  for (let eIdx = 0; eIdx < workingEdges.length; eIdx++) {
    const we = workingEdges[eIdx]!;
    const origSrc = graph.nodes[we.origSrcLocal]!;
    const origDst = graph.nodes[we.origDstLocal]!;
    const labelW = we.input.labelWidth ?? 0;
    const labelH = we.input.labelHeight ?? 16;

    if (we.isFeedback) {
      // Back-loop orthogonal routing: exit src East port, travel top/bottom corridor, enter dst West port
      const corridor = backLoopCorridor.get(eIdx) ?? "bottom";
      const exitSlot = exitOffsetByLayer[origSrc.layer] ?? 0;
      exitOffsetByLayer[origSrc.layer] = exitSlot + 1;
      const entrySlot = entryOffsetByLayer[origDst.layer] ?? 0;
      entryOffsetByLayer[origDst.layer] = entrySlot + 1;

      const x1 = origSrc.x + getActualWidth(origSrc);
      const y1 = Math.round(origSrc.y + origSrc.height / 2);
      const x2 = origDst.x;
      const y2 = Math.round(origDst.y + origDst.height / 2);

      const exitX = Math.round(
        (colX[origSrc.layer] ?? 0) +
          (colWidth[origSrc.layer] ?? 0) +
          18 +
          exitSlot * 12,
      );
      const entryX = Math.round(
        (colX[origDst.layer] ?? 0) - 18 - entrySlot * 12,
      );

      let corridorY: number;
      if (corridor === "top") {
        corridorY = Math.round(
          nodeBaseY -
            opts.backLoopMargin -
            topLaneCursor * opts.backLoopLaneSpacing,
        );
        topLaneCursor++;
      } else {
        corridorY = Math.round(
          nodeBaseY +
            compMaxBottom +
            opts.backLoopMargin +
            bottomLaneCursor * opts.backLoopLaneSpacing,
        );
        bottomLaneCursor++;
      }

      const rawPts: LayoutPoint[] = [
        { x: x1, y: y1 },
        { x: exitX, y: y1 },
        { x: exitX, y: corridorY },
        { x: entryX, y: corridorY },
        { x: entryX, y: y2 },
        { x: x2, y: y2 },
      ];
      const { points, path } = buildRoundedOrthogonalPath(
        rawPts,
        opts.cornerRadius,
      );

      const midX = (exitX + entryX) / 2;
      const spanX = entryX - exitX;
      const labelCandidates: LayoutPoint[] = [
        { x: midX, y: corridorY },
        { x: exitX + spanX * 0.35, y: corridorY },
        { x: exitX + spanX * 0.65, y: corridorY },
        { x: exitX + spanX * 0.22, y: corridorY },
        { x: exitX + spanX * 0.78, y: corridorY },
      ];
      const labelAnchor = chooseCollisionFreeLabelAnchor(
        labelCandidates,
        labelW,
        labelH,
        nodeRects,
        placedLabels,
      );

      if (exitX + 12 > maxRight) maxRight = exitX + 12;
      if (corridorY + labelH / 2 + 8 > maxBottom) {
        maxBottom = corridorY + labelH / 2 + 8;
      }

      routedEdges.push({
        id: we.input.id,
        sourceId: we.input.sourceId,
        targetId: we.input.targetId,
        x1,
        y1,
        x2,
        y2,
        points,
        path,
        labelX: labelAnchor.x,
        labelY: labelAnchor.y,
        isFeedback: true,
        reversed: we.reversed,
        busGroupKey: we.input.busGroupKey ?? null,
        isBusMember: false,
        slotIndex: -1,
      });
      continue;
    }

    // Forward orthogonal routing across gutters
    const links = graph.edgeSegLinks[eIdx]!;
    if (links.length === 0) continue;

    const firstLink = links[0]!;
    const lastLink = links[links.length - 1]!;
    const firstPlan = gutterPlans[firstLink.layer]!;
    const lastPlan = gutterPlans[lastLink.layer]!;

    const firstSegIdx = segIndexByGutterAndEdge.get(
      `${firstLink.layer}:${eIdx}:${firstLink.srcLocal}->${firstLink.dstLocal}`,
    )!;
    const lastSegIdx = segIndexByGutterAndEdge.get(
      `${lastLink.layer}:${eIdx}:${lastLink.srcLocal}->${lastLink.dstLocal}`,
    )!;

    const x1 = origSrc.x + getActualWidth(origSrc);
    const y1 =
      firstPlan.srcPortYs.get(firstSegIdx) ??
      Math.round(origSrc.y + origSrc.height / 2);
    const x2 = origDst.x;
    const y2 =
      lastPlan.dstPortYs.get(lastSegIdx) ??
      Math.round(origDst.y + origDst.height / 2);

    const rawPoints: LayoutPoint[] = [{ x: x1, y: y1 }];
    const labelCandidates: LayoutPoint[] = [];
    let primarySlotIndex = 0;
    let isBusMember = false;
    let resolvedBusKey: string | null = we.input.busGroupKey ?? null;

    for (let k = 0; k < links.length; k++) {
      const link = links[k]!;
      const g = link.layer;
      const plan = gutterPlans[g]!;
      const segSrcNode = graph.nodes[link.srcLocal]!;
      const segDstNode = graph.nodes[link.dstLocal]!;

      const portInY =
        k === 0 ? y1 : Math.round(segSrcNode.y + segSrcNode.height / 2);
      const portOutY =
        k === links.length - 1
          ? y2
          : Math.round(segDstNode.y + segDstNode.height / 2);

      // Check whether this link belongs to a bus group
      const matchedBus = plan.busGroups.find((bg) =>
        bg.edgeIndices.includes(eIdx),
      );
      if (matchedBus && k === 0) {
        isBusMember = true;
        resolvedBusKey = matchedBus.busGroupKey.replace(/#\d+$/, "");
      }

      const key = matchedBus
        ? `bus:${matchedBus.busGroupKey}`
        : `seg:${eIdx}:${link.srcLocal}->${link.dstLocal}`;
      const slotInfo = plan.slotOfSegment.get(key) ?? { slot: 0 };
      if (k === 0) primarySlotIndex = slotInfo.slot;

      const xSlot = slotXInGutter(g, slotInfo.slot);
      if (Math.abs(portInY - portOutY) >= 1) {
        if (slotInfo.splitSlot !== undefined && slotInfo.ySplit !== undefined) {
          const xSplitSlot = slotXInGutter(g, slotInfo.splitSlot);
          rawPoints.push(
            { x: xSlot, y: portInY },
            { x: xSlot, y: slotInfo.ySplit },
            { x: xSplitSlot, y: slotInfo.ySplit },
            { x: xSplitSlot, y: portOutY },
          );
          labelCandidates.push({
            x: (xSlot + xSplitSlot) / 2,
            y: slotInfo.ySplit,
          });
        } else {
          rawPoints.push({ x: xSlot, y: portInY }, { x: xSlot, y: portOutY });
        }
      }

      // Add gutter & intermediate dummy label anchor candidates
      if (k < links.length - 1 && segDstNode.isDummy) {
        const cx = segDstNode.x + segDstNode.width / 2;
        const cy = segDstNode.y + segDstNode.height / 2;
        if (segDstNode.dummyKind === "LABEL") {
          labelCandidates.unshift({ x: cx, y: cy });
        } else {
          labelCandidates.push({ x: cx, y: cy });
        }
        rawPoints.push({ x: segDstNode.x, y: portOutY });
        rawPoints.push({ x: segDstNode.x + segDstNode.width, y: portOutY });
      } else if (links.length === 1) {
        const gLeft = (colX[g] ?? 0) + (colWidth[g] ?? 0);
        const gRight = colX[g + 1] ?? x2;
        const midGutterX = (gLeft + gRight) / 2;
        if (Math.abs(portInY - portOutY) < 1) {
          labelCandidates.push(
            { x: midGutterX, y: portInY - 10 },
            { x: midGutterX, y: portInY + 12 },
          );
        } else {
          // Prefer exit or entry horizontal branch away from vertical trunk
          const exitMidX = (x1 + xSlot) / 2;
          const entryMidX = (xSlot + x2) / 2;
          const exitLen = Math.abs(xSlot - x1);
          const entryLen = Math.abs(x2 - xSlot);
          if (entryLen >= exitLen) {
            labelCandidates.push(
              { x: entryMidX, y: portOutY },
              { x: exitMidX, y: portInY },
              { x: xSlot, y: (portInY + portOutY) / 2 },
            );
          } else {
            labelCandidates.push(
              { x: exitMidX, y: portInY },
              { x: entryMidX, y: portOutY },
              { x: xSlot, y: (portInY + portOutY) / 2 },
            );
          }
          labelCandidates.push(
            { x: entryMidX, y: portOutY - 14 },
            { x: exitMidX, y: portInY - 14 },
          );
        }
      }
    }

    rawPoints.push({ x: x2, y: y2 });
    const { points, path } = buildRoundedOrthogonalPath(
      rawPoints,
      opts.cornerRadius,
    );

    if (labelCandidates.length === 0) {
      labelCandidates.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
    }
    const labelAnchor = chooseCollisionFreeLabelAnchor(
      labelCandidates,
      labelW,
      labelH,
      nodeRects,
      placedLabels,
    );

    routedEdges.push({
      id: we.input.id,
      sourceId: we.input.sourceId,
      targetId: we.input.targetId,
      x1,
      y1,
      x2,
      y2,
      points,
      path,
      labelX: labelAnchor.x,
      labelY: labelAnchor.y,
      isFeedback: false,
      reversed: false,
      busGroupKey: resolvedBusKey,
      isBusMember,
      slotIndex: primarySlotIndex,
    });
  }

  return {
    nodes: positionedNodes,
    edges: routedEdges,
    busTrunks,
    junctions,
    width: Math.round(maxRight + opts.padding),
    height: Math.round(maxBottom),
    maxLayerCount: numLayers,
  };
}

function packIsolatedGrid(
  isolatedNodes: ReadonlyArray<LayoutNodeInput>,
  topOffsetY: number,
  rowOffset: number,
  componentIndex: number,
  opts: ResolvedOptions,
): {
  readonly nodes: PositionedLayoutNode[];
  readonly width: number;
  readonly height: number;
  readonly colsUsed: number;
} {
  if (isolatedNodes.length === 0) {
    return {
      nodes: [],
      width: opts.padding * 2,
      height: topOffsetY,
      colsUsed: 0,
    };
  }

  const autoCols = clamp(
    1,
    6,
    isolatedNodes.length < 4
      ? isolatedNodes.length
      : clamp(4, 6, Math.ceil(Math.sqrt(isolatedNodes.length * 1.4))),
  );
  const cols =
    opts.isolatedCols !== undefined
      ? clamp(1, isolatedNodes.length, opts.isolatedCols)
      : autoCols;
  const rows = Math.ceil(isolatedNodes.length / cols);

  const colWidths = new Float64Array(cols);
  const rowHeights = new Float64Array(rows);

  for (let i = 0; i < isolatedNodes.length; i++) {
    const node = isolatedNodes[i]!;
    const col = i % cols;
    const row = Math.floor(i / cols);
    if (node.width > (colWidths[col] ?? 0)) colWidths[col] = node.width;
    if (node.height > (rowHeights[row] ?? 0)) rowHeights[row] = node.height;
  }

  const colX = new Float64Array(cols);
  colX[0] = opts.padding;
  for (let c = 1; c < cols; c++) {
    colX[c] = (colX[c - 1] ?? 0) + (colWidths[c - 1] ?? 0) + opts.isolatedGapX;
  }

  const rowY = new Float64Array(rows);
  rowY[0] = topOffsetY;
  for (let r = 1; r < rows; r++) {
    rowY[r] = (rowY[r - 1] ?? 0) + (rowHeights[r - 1] ?? 0) + opts.isolatedGapY;
  }

  const positioned: PositionedLayoutNode[] = [];
  let maxRight = opts.padding;
  let maxBottom = topOffsetY;

  for (let i = 0; i < isolatedNodes.length; i++) {
    const node = isolatedNodes[i]!;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = Math.round(colX[col] ?? opts.padding);
    const y = Math.round(rowY[row] ?? topOffsetY);
    const width = Math.round(
      opts.uniformColumnWidth ? (colWidths[col] ?? node.width) : node.width,
    );
    const height = node.height;
    positioned.push({
      id: node.id,
      layer: col,
      row: rowOffset + row,
      x,
      y,
      width,
      height,
      componentIndex,
      isIsolated: true,
    });
    if (x + width > maxRight) maxRight = x + width;
    if (y + height > maxBottom) maxBottom = y + height;
  }

  return {
    nodes: positioned,
    width: Math.round(maxRight + opts.padding),
    height: Math.round(maxBottom),
    colsUsed: cols,
  };
}

export function computeHierarchicLayout(
  nodes: ReadonlyArray<LayoutNodeInput>,
  edges: ReadonlyArray<LayoutEdgeInput>,
  options?: HierarchicLayoutOptions,
): HierarchicLayoutResult {
  const opts = resolveOptions(options);
  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      busTrunks: [],
      junctions: [],
      nodeById: new Map(),
      width: opts.padding * 2,
      height: opts.padding * 2,
      layerCount: 0,
      componentCount: 0,
      isolatedCount: 0,
    };
  }

  const { activeComponents, isolatedNodes } = partitionComponents(nodes, edges);
  const allNodes: PositionedLayoutNode[] = [];
  const allEdges: RoutedLayoutEdge[] = [];
  const allBusTrunks: BusTrunkSegment[] = [];
  const allJunctions: BusJunctionPoint[] = [];

  let currentY = opts.padding;
  let maxWidth = opts.padding * 2;
  let maxLayerCount = 0;
  let maxActiveRow = -1;

  for (let c = 0; c < activeComponents.length; c++) {
    const compResult = layoutActiveComponent(
      activeComponents[c]!,
      c,
      currentY,
      opts,
    );
    for (const pn of compResult.nodes) {
      allNodes.push(pn);
      if (pn.row > maxActiveRow) maxActiveRow = pn.row;
    }
    for (const re of compResult.edges) allEdges.push(re);
    for (const bt of compResult.busTrunks) allBusTrunks.push(bt);
    for (const j of compResult.junctions) allJunctions.push(j);

    if (compResult.width > maxWidth) maxWidth = compResult.width;
    if (compResult.maxLayerCount > maxLayerCount) {
      maxLayerCount = compResult.maxLayerCount;
    }
    currentY = compResult.height + opts.componentGap;
  }

  const trayTopY = activeComponents.length > 0 ? currentY : opts.padding;
  const trayResult = packIsolatedGrid(
    isolatedNodes,
    trayTopY,
    maxActiveRow + 1,
    activeComponents.length,
    opts,
  );
  for (const pn of trayResult.nodes) allNodes.push(pn);
  if (trayResult.width > maxWidth) maxWidth = trayResult.width;
  if (activeComponents.length === 0 && trayResult.colsUsed > maxLayerCount) {
    maxLayerCount = trayResult.colsUsed;
  }

  const nodeById = new Map<number, PositionedLayoutNode>();
  for (const pn of allNodes) {
    nodeById.set(pn.id, pn);
  }

  let totalBottom = opts.padding;
  if (isolatedNodes.length > 0) {
    totalBottom = trayResult.height + opts.padding;
  } else if (activeComponents.length > 0) {
    totalBottom = currentY - opts.componentGap + opts.padding;
  }

  return {
    nodes: allNodes,
    edges: allEdges,
    busTrunks: allBusTrunks,
    junctions: allJunctions,
    nodeById,
    width: Math.max(opts.padding * 2, Math.round(maxWidth)),
    height: Math.max(opts.padding * 2, Math.round(totalBottom)),
    layerCount: maxLayerCount,
    componentCount: activeComponents.length,
    isolatedCount: isolatedNodes.length,
  };
}
