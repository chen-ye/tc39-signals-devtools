import { describe, expect, test } from "bun:test";
import {
  computeGraphLayout,
  LAYER_GAP,
  NODE_WIDTH,
} from "../../src/panel/graph-layout.ts";
import type {
  SignalEdgeSnapshot,
  SignalNodeSnapshot,
} from "../../src/protocol/types.ts";

function makeNode(
  id: number,
  kind: SignalNodeSnapshot["kind"],
  label: string,
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
  };
}

describe("computeGraphLayout", () => {
  test("handles empty graphs cleanly", () => {
    const layout = computeGraphLayout([], []);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.layerCount).toBe(0);
  });

  test("assigns longest-path layers for diamond DAG with strict left-to-right edges", () => {
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

    expect(layout.nodeById.get(3)!.x - layout.nodeById.get(1)!.x).toBe(
      NODE_WIDTH + LAYER_GAP,
    );
    for (const edge of layout.edges) {
      expect(edge.x1).toBeLessThan(edge.x2);
      expect(edge.path.startsWith("M ")).toBe(true);
    }
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
});
