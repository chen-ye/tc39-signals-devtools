import { describe, expect, test } from "bun:test";
import {
  computeGraphLayout,
  NODE_HEIGHT,
  NODE_WIDTH,
  type LayoutPoint,
} from "../../src/panel/graph-layout.ts";
import type {
  SignalEdgeSnapshot,
  SignalNodeSnapshot,
} from "../../src/protocol/types.ts";

function makeNode(
  id: number,
  kind: SignalNodeSnapshot["kind"],
  label: string | null,
  extra?: Partial<SignalNodeSnapshot>,
): SignalNodeSnapshot {
  return {
    id,
    kind,
    label,
    runtime: "test",
    runtimeMode: "instrumented",
    site: null,
    value: kind === "watcher" ? null : { kind: "number", text: String(id) },
    error: null,
    unread: false,
    live: true,
    sets: 0,
    runs: 0,
    notifies: 0,
    lastRunMs: null,
    lastChangedSeq: 0,
    causes: [],
    ...extra,
  };
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function segmentIntersectsCardInterior(
  p1: LayoutPoint,
  p2: LayoutPoint,
  card: { x: number; y: number; width: number; height: number },
): boolean {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  const left = card.x + 0.5;
  const right = card.x + card.width - 0.5;
  const top = card.y + 0.5;
  const bottom = card.y + card.height - 0.5;

  return maxX > left && minX < right && maxY > top && minY < bottom;
}

function assertAllSegmentsClearCards(
  edges: ReadonlyArray<{ readonly points?: ReadonlyArray<LayoutPoint> }>,
  cards: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): void {
  for (const edge of edges) {
    const pts = edge.points ?? [];
    expect(pts.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      for (const card of cards) {
        expect(segmentIntersectsCardInterior(a, b, card)).toBe(false);
      }
    }
  }
}

describe("computeGraphLayout", () => {
  test("handles empty graphs cleanly", () => {
    const layout = computeGraphLayout([], []);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.busTrunks).toEqual([]);
    expect(layout.junctions).toEqual([]);
    expect(layout.layerCount).toBe(0);
  });

  test("assigns longest-path layers for diamond DAG with strict left-to-right edges and no transitive reduction", () => {
    const nodes: SignalNodeSnapshot[] = [
      makeNode(1, "state", "a"),
      makeNode(2, "state", "b"),
      makeNode(3, "computed", "mid"),
      makeNode(4, "computed", "sum"),
      makeNode(5, "watcher", "watch"),
    ];
    // sum depends on BOTH a (layer 0) and mid (layer 1), so sum must sit in layer 2!
    const edges: SignalEdgeSnapshot[] = [
      { sourceId: 1, sinkId: 3 },
      { sourceId: 2, sinkId: 3 },
      { sourceId: 1, sinkId: 4 },
      { sourceId: 3, sinkId: 4 },
      { sourceId: 4, sinkId: 5 },
    ];

    const layout = computeGraphLayout(nodes, edges);
    expect(layout.layerCount).toBe(4);
    expect(layout.nodeById.get(1)?.layer).toBe(0);
    expect(layout.nodeById.get(2)?.layer).toBe(0);
    expect(layout.nodeById.get(3)?.layer).toBe(1);
    expect(layout.nodeById.get(4)?.layer).toBe(2);
    expect(layout.nodeById.get(5)?.layer).toBe(3);

    expect(
      layout.nodeById.get(3)!.x - layout.nodeById.get(1)!.x,
    ).toBeGreaterThanOrEqual(NODE_WIDTH + 60);

    // Transitive edge 1 -> 4 must remain visible alongside 1 -> 3 -> 4
    expect(layout.edges.length).toBe(5);
    expect(layout.edges.some((e) => e.sourceId === 1 && e.sinkId === 4)).toBe(
      true,
    );

    for (const edge of layout.edges) {
      expect(edge.x1).toBeLessThan(edge.x2);
      expect(edge.isFeedback).toBe(false);
      expect(edge.path.startsWith("M ")).toBe(true);
    }
    assertAllSegmentsClearCards(layout.edges, layout.nodes);
  });

  test("never infinite-loops on cyclic edges and produces valid coordinates", () => {
    const nodes: SignalNodeSnapshot[] = [
      makeNode(1, "computed", "x"),
      makeNode(2, "computed", "y"),
    ];
    const edges: SignalEdgeSnapshot[] = [
      { sourceId: 1, sinkId: 2 },
      { sourceId: 2, sinkId: 1 },
    ];

    const layout = computeGraphLayout(nodes, edges);
    expect(layout.nodes.length).toBe(2);
    expect(layout.edges.length).toBe(2);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    assertAllSegmentsClearCards(layout.edges, layout.nodes);
  });

  test("positions disconnected nodes without overlapping y coordinates and aligns unread Computed/Watcher columns", () => {
    const nodes: SignalNodeSnapshot[] = [
      makeNode(1, "state", "s1"),
      makeNode(2, "state", "s2"),
      makeNode(3, "computed", "unreadComp"),
      makeNode(4, "watcher", "idleWatch"),
    ];
    const layout = computeGraphLayout(nodes, []);
    expect(layout.nodeById.get(1)?.layer).toBe(0);
    expect(layout.nodeById.get(2)?.layer).toBe(0);
    expect(layout.nodeById.get(3)?.layer).toBe(1);
    expect(layout.nodeById.get(4)?.layer).toBe(2);
    const ys = layout.nodes.map((n) => n.y);
    expect(new Set(ys.slice(0, 2)).size).toBe(2);
  });

  test("eliminates 'computed · new Mi...' truncation with semantic stripping, adaptive widths, and two-line wrapping", () => {
    const nodes: SignalNodeSnapshot[] = [
      makeNode(1, "computed", "computed · new MiniCartStore"),
      makeNode(2, "computed", null, {
        site: {
          file: "src/cart.ts",
          line: 14,
          column: 5,
          fn: "new MiniCartDashboardController",
        },
        ownerLabel: "CartModule",
      }),
      makeNode(3, "computed", null, {
        autoLabel:
          "computed · new MiniCartShoppingCheckoutOrderSummaryController",
      }),
      makeNode(4, "state", "state · subtotal (PricingStore)"),
      makeNode(5, "watcher", "<ui-dashboard-route-canvas-map-summary-panel>"),
    ];
    const edges: SignalEdgeSnapshot[] = [
      { sourceId: 4, sinkId: 1 },
      { sourceId: 1, sinkId: 2 },
      { sourceId: 2, sinkId: 3 },
      { sourceId: 3, sinkId: 5 },
    ];

    const layout = computeGraphLayout(nodes, edges);

    const n1 = layout.nodeById.get(1)!;
    expect(n1.formattedTitle).toBe("MiniCartStore");
    expect(n1.formattedTitleLines).toEqual({
      line1: "MiniCartStore",
      line2: null,
    });
    expect(n1.height).toBe(NODE_HEIGHT);
    expect(n1.width).toBeGreaterThanOrEqual(224);
    expect(n1.width).toBeLessThanOrEqual(296);

    const n2 = layout.nodeById.get(2)!;
    expect(n2.formattedTitle).toBe("MiniCartDashboardController");
    expect(n2.formattedTitle?.includes("Mi…")).toBe(false);
    expect(n2.subtitleLabel).toBe("CartModule");
    expect(n2.width).toBeGreaterThanOrEqual(224);
    expect(n2.width).toBeLessThanOrEqual(296);

    const n3 = layout.nodeById.get(3)!;
    expect(n3.width).toBe(296);
    expect(n3.formattedTitleLines?.line2).not.toBeNull();
    expect(n3.height).toBe(86);
    const combined = `${n3.formattedTitleLines?.line1 ?? ""}${n3.formattedTitleLines?.line2 ?? ""}`;
    expect(combined).toBe("MiniCartShoppingCheckoutOrderSummaryController");

    const n4 = layout.nodeById.get(4)!;
    expect(n4.formattedTitle).toBe("subtotal");
    expect(n4.subtitleLabel).toBe("PricingStore");
    expect(n4.isCompact).toBe(false);

    const n5 = layout.nodeById.get(5)!;
    expect(n5.width).toBe(296);
    expect(n5.formattedTitleLines?.line2).not.toBeNull();
    expect(n5.height).toBe(86);
    expect(n5.formattedTitle?.startsWith("<ui-")).toBe(true);
    expect(n5.formattedTitle?.endsWith(">")).toBe(true);
  });

  test("breaks multi-node cycles via FAS and routes orthogonal back-loops around all cards", () => {
    const nodes: SignalNodeSnapshot[] = [
      makeNode(1, "state", "root"),
      makeNode(2, "computed", "stepA"),
      makeNode(3, "computed", "stepB"),
      makeNode(4, "computed", "stepC"),
      makeNode(5, "watcher", "sink"),
    ];
    const edges: SignalEdgeSnapshot[] = [
      { sourceId: 1, sinkId: 2 },
      { sourceId: 2, sinkId: 3 },
      { sourceId: 3, sinkId: 4 },
      { sourceId: 4, sinkId: 2 }, // feedback cycle edge
      { sourceId: 4, sinkId: 5 },
    ];

    const layout = computeGraphLayout(nodes, edges);
    const l1 = layout.nodeById.get(1)!.layer;
    const l2 = layout.nodeById.get(2)!.layer;
    const l3 = layout.nodeById.get(3)!.layer;
    const l4 = layout.nodeById.get(4)!.layer;
    const l5 = layout.nodeById.get(5)!.layer;

    expect(l1).toBeLessThan(l2);
    expect(l2).toBeLessThan(l3);
    expect(l3).toBeLessThan(l4);
    expect(l4).toBeLessThan(l5);

    const feedback = layout.edges.find(
      (e) => e.sourceId === 4 && e.sinkId === 2,
    )!;
    expect(feedback.isFeedback).toBe(true);
    expect(feedback.points?.length).toBeGreaterThanOrEqual(4);
    expect(feedback.path.includes(" Q ")).toBe(true);

    for (const fwd of layout.edges.filter((e) => e !== feedback)) {
      expect(fwd.isFeedback).toBe(false);
      expect(fwd.x1).toBeLessThan(fwd.x2);
    }

    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        expect(boxesOverlap(layout.nodes[i]!, layout.nodes[j]!)).toBe(false);
      }
    }
    assertAllSegmentsClearCards(layout.edges, layout.nodes);
  });

  test("packs 0-degree isolated nodes in a 4-6 column grid below active DAGs", () => {
    const nodes: SignalNodeSnapshot[] = [
      makeNode(1, "state", "source"),
      makeNode(2, "computed", "derived"),
      makeNode(3, "computed", "formatted"),
      makeNode(4, "watcher", "effect"),
      ...Array.from({ length: 10 }, (_, idx) =>
        makeNode(100 + idx, idx % 2 === 0 ? "state" : "computed", `iso_${idx}`),
      ),
    ];
    const edges: SignalEdgeSnapshot[] = [
      { sourceId: 1, sinkId: 2 },
      { sourceId: 2, sinkId: 3 },
      { sourceId: 3, sinkId: 4 },
    ];

    const layout = computeGraphLayout(nodes, edges);
    const active = layout.nodes.filter((n) => n.isIsolated === false);
    const isolated = layout.nodes.filter((n) => n.isIsolated === true);

    expect(active.length).toBe(4);
    expect(isolated.length).toBe(10);

    const maxActiveBottom = Math.max(...active.map((n) => n.y + n.height));
    const minIsolatedTop = Math.min(...isolated.map((n) => n.y));
    expect(minIsolatedTop).toBeGreaterThan(maxActiveBottom + 30);

    const distinctCols = new Set(isolated.map((n) => n.x));
    expect(distinctCols.size).toBeGreaterThanOrEqual(4);
    expect(distinctCols.size).toBeLessThanOrEqual(6);

    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        expect(boxesOverlap(layout.nodes[i]!, layout.nodes[j]!)).toBe(false);
      }
    }
    assertAllSegmentsClearCards(layout.edges, layout.nodes);
  });

  test("bundles fanOut >= 5 from State and Computed onto shared bus trunks with crisp junctions", () => {
    const nodes: SignalNodeSnapshot[] = [
      makeNode(1, "state", "globalConfig"),
      // 6 computeds fed by state #1 (fanOut = 6 >= 5)
      makeNode(2, "computed", "c1"),
      makeNode(3, "computed", "c2"),
      makeNode(4, "computed", "c3"),
      makeNode(5, "computed", "c4"),
      makeNode(6, "computed", "c5"),
      makeNode(7, "computed", "c6"),
      // 5 watchers fed by computed #2 (fanOut = 5 >= 5)
      makeNode(8, "watcher", "w1"),
      makeNode(9, "watcher", "w2"),
      makeNode(10, "watcher", "w3"),
      makeNode(11, "watcher", "w4"),
      makeNode(12, "watcher", "w5"),
      // Control computed #3 with fanOut = 4 (< 5 -> no bus)
      makeNode(13, "watcher", "w6"),
      makeNode(14, "watcher", "w7"),
      makeNode(15, "watcher", "w8"),
      makeNode(16, "watcher", "w9"),
    ];
    const edges: SignalEdgeSnapshot[] = [
      ...[2, 3, 4, 5, 6, 7].map((sinkId) => ({ sourceId: 1, sinkId })),
      ...[8, 9, 10, 11, 12].map((sinkId) => ({ sourceId: 2, sinkId })),
      ...[13, 14, 15, 16].map((sinkId) => ({ sourceId: 3, sinkId })),
    ];

    const layout = computeGraphLayout(nodes, edges);
    const trunks = layout.busTrunks ?? [];
    const junctions = layout.junctions ?? [];

    expect(trunks.length).toBe(2);

    const stateTrunk = trunks.find((t) => t.sourceId === 1)!;
    expect(stateTrunk.kind).toBe("state");
    expect(stateTrunk.busGroupKey).toBe("fanout:1");
    expect(stateTrunk.memberEdgeIds.length).toBe(6);

    const computedTrunk = trunks.find((t) => t.sourceId === 2)!;
    expect(computedTrunk.kind).toBe("computed");
    expect(computedTrunk.busGroupKey).toBe("fanout:2");
    expect(computedTrunk.memberEdgeIds.length).toBe(5);

    expect(trunks.some((t) => t.sourceId === 3)).toBe(false);

    for (const trunk of trunks) {
      const src = layout.nodeById.get(trunk.sourceId)!;
      expect(trunk.x).toBeGreaterThan(src.x + src.width);
      for (const card of layout.nodes) {
        expect(
          segmentIntersectsCardInterior(
            { x: trunk.x, y: trunk.yStart },
            { x: trunk.x, y: trunk.yEnd },
            card,
          ),
        ).toBe(false);
      }
    }

    expect(junctions.length).toBeGreaterThanOrEqual(11);
    expect(junctions.some((j) => j.kind === "state")).toBe(true);
    expect(junctions.some((j) => j.kind === "computed")).toBe(true);

    for (const edge of layout.edges) {
      if (edge.sourceId === 1 || edge.sourceId === 2) {
        expect(edge.isBusMember).toBe(true);
        expect(edge.busGroupKey).toBe(`fanout:${edge.sourceId}`);
      } else {
        expect(edge.isBusMember).toBe(false);
      }
    }

    assertAllSegmentsClearCards(layout.edges, layout.nodes);
  });

  test("400-node / 450-edge stress layout completes in < 150ms with zero overlaps or card intersections", () => {
    const nodes: SignalNodeSnapshot[] = [];
    const edges: SignalEdgeSnapshot[] = [];

    let nextId = 1;
    const states: number[] = [];
    for (let i = 0; i < 60; i++) {
      nodes.push(makeNode(nextId, "state", `state_${i}`));
      states.push(nextId++);
    }
    const compTier1: number[] = [];
    for (let i = 0; i < 100; i++) {
      nodes.push(makeNode(nextId, "computed", `computed · new TierOne_${i}`));
      compTier1.push(nextId++);
    }
    const compTier2: number[] = [];
    for (let i = 0; i < 100; i++) {
      nodes.push(makeNode(nextId, "computed", `selectTierTwo_${i}`));
      compTier2.push(nextId++);
    }
    const watchers: number[] = [];
    for (let i = 0; i < 100; i++) {
      nodes.push(makeNode(nextId, "watcher", `watcher_${i}`));
      watchers.push(nextId++);
    }
    // 40 isolated 0-degree nodes -> 400 total
    for (let i = 0; i < 40; i++) {
      nodes.push(makeNode(nextId++, "state", `isolatedState_${i}`));
    }
    expect(nodes.length).toBe(400);

    // 100 state -> tier1 + 60 secondary state -> tier1 = 160
    for (let i = 0; i < compTier1.length; i++) {
      edges.push({
        sourceId: states[i % states.length]!,
        sinkId: compTier1[i]!,
      });
      if (i < 60) {
        edges.push({
          sourceId: states[(i + 7) % states.length]!,
          sinkId: compTier1[i]!,
        });
      }
    }
    // 100 tier1 -> tier2 + 40 transitive state -> tier2 + 40 secondary tier1 -> tier2 = 180
    for (let i = 0; i < compTier2.length; i++) {
      edges.push({ sourceId: compTier1[i]!, sinkId: compTier2[i]! });
      if (i < 40) {
        edges.push({
          sourceId: states[i % states.length]!,
          sinkId: compTier2[i]!,
        });
        edges.push({
          sourceId: compTier1[(i + 1) % compTier1.length]!,
          sinkId: compTier2[i]!,
        });
      }
    }
    // 100 tier2 -> watcher + 10 tier1 -> watcher + 5 feedback edges = 115 (total 455)
    for (let i = 0; i < watchers.length; i++) {
      edges.push({ sourceId: compTier2[i]!, sinkId: watchers[i]! });
      if (i < 10) {
        edges.push({ sourceId: compTier1[i]!, sinkId: watchers[i]! });
      }
    }
    for (let i = 0; i < 5; i++) {
      const idx = i * 15;
      edges.push({ sourceId: compTier2[idx]!, sinkId: compTier1[idx]! });
    }
    expect(edges.length).toBeGreaterThanOrEqual(450);

    // Warm JIT once then measure layout call
    computeGraphLayout(nodes, edges);
    const t0 = performance.now();
    const layout = computeGraphLayout(nodes, edges);
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(150);
    expect(layout.nodes.length).toBe(400);
    expect(layout.edges.length).toBe(edges.length);
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(Number.isFinite(layout.height)).toBe(true);
    expect(layout.nodes.filter((n) => n.isIsolated === true).length).toBe(40);

    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        expect(boxesOverlap(layout.nodes[i]!, layout.nodes[j]!)).toBe(false);
      }
    }
    assertAllSegmentsClearCards(layout.edges, layout.nodes);
  });
});
