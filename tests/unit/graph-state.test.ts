import { describe, expect, test } from "bun:test";
import { Signal as RealSignal } from "signal-polyfill";
import { createSignalsHook } from "../../src/hook/hook.ts";
import {
  DEFAULT_FILTER_STATE,
  derivePanelViewModel,
  formatNodeDisplayName,
} from "../../src/panel/graph-state.ts";
import {
  clearRuntimeTokens,
  rewriteFieldInclusionsToExclusions,
  setRuntimeOnlyInQuery,
} from "../../src/shared/query-parser.ts";
import type {
  GraphSnapshot,
  SignalEdgeSnapshot,
  SignalNodeSnapshot,
} from "../../src/protocol/types.ts";

function makeNode(
  overrides: Partial<SignalNodeSnapshot> &
    Pick<SignalNodeSnapshot, "id" | "kind">,
): SignalNodeSnapshot {
  return {
    label: null,
    autoLabel: null,
    ownerLabel: null,
    runtime: "signal-polyfill",
    runtimeMode: "instrumented",
    site: null,
    value: null,
    error: null,
    unread: false,
    live: true,
    sets: 0,
    runs: 0,
    notifies: 0,
    lastRunMs: null,
    lastChangedSeq: 1,
    causes: [],
    computeSource: null,
    computeSignature: null,
    internal: false,
    ...overrides,
  };
}

function makeSnapshot(
  nodes: ReadonlyArray<SignalNodeSnapshot>,
  edges: ReadonlyArray<SignalEdgeSnapshot> = [],
): GraphSnapshot {
  const seenRuntimes = new Map<string, SignalNodeSnapshot["runtimeMode"]>();
  for (const node of nodes) {
    if (!seenRuntimes.has(node.runtime)) {
      seenRuntimes.set(node.runtime, node.runtimeMode);
    }
  }
  return {
    version: 1,
    seq: 10,
    baseSeq: 0,
    droppedEvents: 0,
    settings: {
      writeStacks: false,
      paused: false,
    },
    runtimes: Array.from(seenRuntimes, ([name, mode]) => ({ name, mode })),
    nodes,
    edges,
    events: [],
  };
}

describe("formatNodeDisplayName", () => {
  test("prefers explicit label, then autoLabel, then cleaned site.fn without kind prefix, then kind #id", () => {
    expect(
      formatNodeDisplayName(
        makeNode({
          id: 1,
          kind: "computed",
          label: "explicitName",
          autoLabel: "autoName",
          site: { file: "a.ts", line: 1, column: 1, fn: "new Foo" },
        }),
      ),
    ).toBe("explicitName");

    expect(
      formatNodeDisplayName(
        makeNode({
          id: 2,
          kind: "computed",
          label: null,
          autoLabel: "fullName",
          site: {
            file: "a.ts",
            line: 1,
            column: 1,
            fn: "new UserStore.<instance_members_initializer>",
          },
        }),
      ),
    ).toBe("fullName");

    expect(
      formatNodeDisplayName(
        makeNode({
          id: 3,
          kind: "computed",
          site: {
            file: "a.ts",
            line: 1,
            column: 1,
            fn: "new CartModel.<instance_members_initializer>",
          },
        }),
      ),
    ).toBe("CartModel");

    expect(
      formatNodeDisplayName(
        makeNode({
          id: 4,
          kind: "state",
          site: {
            file: "a.ts",
            line: 2,
            column: 3,
            fn: "Object.createCounter",
          },
        }),
      ),
    ).toBe("createCounter");

    expect(
      formatNodeDisplayName(
        makeNode({
          id: 5,
          kind: "watcher",
          site: {
            file: "a.ts",
            line: 3,
            column: 4,
            fn: "new RenderEffect",
          },
        }),
      ),
    ).toBe("RenderEffect");

    expect(
      formatNodeDisplayName(
        makeNode({
          id: 6,
          kind: "computed",
          site: {
            file: "a.ts",
            line: 4,
            column: 1,
            fn: "<instance_members_initializer>",
          },
        }),
      ),
    ).toBe("computed #6");

    expect(
      formatNodeDisplayName(
        makeNode({
          id: 7,
          kind: "state",
          site: {
            file: "a.ts",
            line: 5,
            column: 1,
            fn: "Object.<anonymous>",
          },
        }),
      ),
    ).toBe("state #7");

    expect(formatNodeDisplayName(makeNode({ id: 8, kind: "watcher" }))).toBe(
      "watcher #8",
    );
  });
});

describe("derivePanelViewModel", () => {
  test("computes upstream/downstream transitive sets, direct causes, and filters", () => {
    const hook = createSignalsHook();
    const S = hook.wrap(RealSignal);

    const a = new S.State(1, { name: "price" });
    const b = new S.State(2, { name: "qty" });
    const unrelated = new S.State(10, { name: "unrelated" });
    expect(unrelated.get()).toBe(10);
    const sub = new S.Computed(() => a.get() * b.get(), { name: "subtotal" });
    const total = new S.Computed(() => sub.get() + 5, { name: "total" });
    const watcher = new S.subtle.Watcher(() => {});
    hook.label(watcher, "render");
    watcher.watch(total);
    expect(total.get()).toBe(7);

    a.set(3);
    expect(total.get()).toBe(11);

    const snap = hook.snapshot();
    const idOf = (name: string) => snap.nodes.find((n) => n.label === name)!.id;

    // Select `subtotal`: upstream = {price, qty}, downstream = {total, render}, direct causes = {price}
    const vm = derivePanelViewModel(
      snap,
      DEFAULT_FILTER_STATE,
      idOf("subtotal"),
    );
    expect(vm.stats).toEqual({
      totalNodes: 6,
      stateCount: 3,
      computedCount: 2,
      watcherCount: 1,
      liveCount: 5,
      erroredCount: 0,
      internalCount: 0,
      edgeCount: 4,
    });
    expect(vm.upstreamIds).toEqual(new Set([idOf("price"), idOf("qty")]));
    expect(vm.downstreamIds).toEqual(new Set([idOf("total"), idOf("render")]));
    expect(vm.directCauseIds).toEqual(new Set([idOf("price")]));
    expect(vm.upstreamIds.has(idOf("unrelated"))).toBe(false);

    // Filter by cold liveness -> only `unrelated`
    const coldVm = derivePanelViewModel(
      snap,
      { ...DEFAULT_FILTER_STATE, livenessFilter: "cold" },
      null,
    );
    expect(coldVm.visibleNodes.map((n) => n.label)).toEqual(["unrelated"]);

    // Filter timeline by `set` events
    const setEventsVm = derivePanelViewModel(
      snap,
      {
        ...DEFAULT_FILTER_STATE,
        eventTypeFilter: "set",
        followSelectionInTimeline: true,
      },
      idOf("subtotal"),
    );
    expect(setEventsVm.filteredEvents.length).toBe(1);
    expect(setEventsVm.filteredEvents[0]?.nodeId).toBe(idOf("price"));
  });

  test("returns clean defaults when snapshot is null", () => {
    const vm = derivePanelViewModel(null, DEFAULT_FILTER_STATE, null);
    expect(vm.queryMode).toBe("highlight");
    expect(vm.isHighlightQueryActive).toBe(false);
    expect(vm.searchMatchIds).toEqual(new Set());
    expect(vm.orderedMatchIds).toEqual([]);
    expect(vm.focusedNode).toBeNull();
    expect(vm.runtimeInventory).toEqual([]);
    expect(vm.stats.internalCount).toBe(0);
  });

  test("supports Highlight (default) vs Filter modes and sorts orderedMatchIds by (layer, row, id)", () => {
    const snapshot = makeSnapshot(
      [
        makeNode({
          id: 1,
          kind: "state",
          label: "baseCount",
          site: {
            file: "src/store.ts",
            line: 10,
            column: 2,
            fn: "createStore",
          },
        }),
        makeNode({
          id: 2,
          kind: "computed",
          label: "doubledCount",
          computeSource: "() => baseCount.get() * 2",
          computeSignature: "()",
          unread: true,
        }),
        makeNode({
          id: 3,
          kind: "computed",
          autoLabel: "tripledCount",
          ownerLabel: "CounterCard",
          computeSource: "() => baseCount.get() * 3",
          value: { kind: "number", text: "9" },
        }),
        makeNode({
          id: 4,
          kind: "watcher",
          label: "logEffect",
          runtime: "preact-signals",
          runtimeMode: "registered",
        }),
      ],
      [
        { sourceId: 1, sinkId: 2 },
        { sourceId: 1, sinkId: 3 },
        { sourceId: 3, sinkId: 4 },
      ],
    );

    const highlighted = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, query: "kind:computed" },
      null,
    );
    expect(highlighted.queryMode).toBe("highlight");
    expect(highlighted.isHighlightQueryActive).toBe(true);
    expect(highlighted.visibleNodes.map((n) => n.id)).toEqual([1, 2, 3, 4]);
    expect(highlighted.searchMatchIds).toEqual(new Set([2, 3]));

    const expectedOrder = [2, 3].toSorted((a, b) => {
      const pa = highlighted.layout.nodeById.get(a)!;
      const pb = highlighted.layout.nodeById.get(b)!;
      if (pa.layer !== pb.layer) return pa.layer - pb.layer;
      if (pa.row !== pb.row) return pa.row - pb.row;
      return pa.node.id - pb.node.id;
    });
    expect(highlighted.orderedMatchIds).toEqual(expectedOrder);

    const filtered = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, query: "kind:computed", queryMode: "filter" },
      null,
    );
    expect(filtered.queryMode).toBe("filter");
    expect(filtered.isHighlightQueryActive).toBe(false);
    expect(filtered.visibleNodes.map((n) => n.id)).toEqual([2, 3]);
    expect(filtered.searchMatchIds).toEqual(new Set([2, 3]));

    // Negative exclusions remove nodes in Highlight mode without activating isHighlightQueryActive
    const excludedOnly = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, query: "-runtime:preact-*" },
      null,
    );
    expect(excludedOnly.isHighlightQueryActive).toBe(false);
    expect(excludedOnly.searchMatchIds).toEqual(new Set());
    expect(excludedOnly.orderedMatchIds).toEqual([]);
    expect(excludedOnly.visibleNodes.map((n) => n.id)).toEqual([1, 2, 3]);

    // AST field & free-text matching across computeSource, ownerLabel, autoLabel, is:unread, file:, site.fn
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "baseCount.get() * 3" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([3]));
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "CounterCard" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([3]));
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "tripledCount" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([3]));
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "is:unread" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([2]));
    expect(
      derivePanelViewModel(
        snapshot,
        { ...DEFAULT_FILTER_STATE, query: "file:src/store.ts createStore" },
        null,
      ).searchMatchIds,
    ).toEqual(new Set([1]));
  });

  test("hides internal signals by default and reveals via showInternal, is:internal, or #id", () => {
    const snapshot = makeSnapshot(
      [
        makeNode({ id: 1, kind: "state", label: "count" }),
        makeNode({
          id: 2,
          kind: "state",
          label: "__forceUpdateSignal",
          internal: true,
        }),
        makeNode({
          id: 3,
          kind: "computed",
          label: "__internalMemo",
          internal: true,
        }),
        makeNode({ id: 4, kind: "watcher", label: "renderEffect" }),
      ],
      [
        { sourceId: 1, sinkId: 4 },
        { sourceId: 2, sinkId: 4 },
      ],
    );

    const defaultVm = derivePanelViewModel(
      snapshot,
      DEFAULT_FILTER_STATE,
      null,
    );
    expect(defaultVm.stats.totalNodes).toBe(4);
    expect(defaultVm.stats.internalCount).toBe(2);
    expect(defaultVm.visibleNodes.map((n) => n.id)).toEqual([1, 4]);
    expect(defaultVm.visibleEdges).toEqual([{ sourceId: 1, sinkId: 4 }]);

    const showInternalVm = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, showInternal: true },
      null,
    );
    expect(showInternalVm.visibleNodes.map((n) => n.id)).toEqual([1, 2, 3, 4]);
    expect(showInternalVm.visibleEdges).toEqual([
      { sourceId: 1, sinkId: 4 },
      { sourceId: 2, sinkId: 4 },
    ]);

    const queryInternalHighlight = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, query: "is:internal" },
      null,
    );
    expect(queryInternalHighlight.visibleNodes.map((n) => n.id)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(queryInternalHighlight.searchMatchIds).toEqual(new Set([2, 3]));
    expect(queryInternalHighlight.isHighlightQueryActive).toBe(true);

    const queryInternalFilter = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, query: "is:internal", queryMode: "filter" },
      null,
    );
    expect(queryInternalFilter.visibleNodes.map((n) => n.id)).toEqual([2, 3]);

    // Explicit #id reveals only that internal node
    const queryById = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, query: "#2" },
      null,
    );
    expect(queryById.visibleNodes.map((n) => n.id)).toEqual([1, 2, 4]);
    expect(queryById.searchMatchIds).toEqual(new Set([2]));

    // Negated -#2 or -is:internal must NOT reveal hidden internal nodes
    const negatedId = derivePanelViewModel(
      snapshot,
      { ...DEFAULT_FILTER_STATE, query: "-#2 -is:internal" },
      null,
    );
    expect(negatedId.visibleNodes.map((n) => n.id)).toEqual([1, 4]);
  });

  test("focusSubgraphNodeId scopes visibleNodes to upstream + downstream neighborhood and computes runtimeInventory", () => {
    const snapshot = makeSnapshot(
      [
        makeNode({
          id: 1,
          kind: "state",
          label: "rootA",
          runtime: "lit-signals",
          runtimeMode: "registered",
        }),
        makeNode({
          id: 2,
          kind: "computed",
          label: "mid",
          runtime: "lit-signals",
          runtimeMode: "registered",
        }),
        makeNode({
          id: 3,
          kind: "watcher",
          label: "leaf",
          runtime: "lit-signals",
          runtimeMode: "registered",
        }),
        makeNode({
          id: 4,
          kind: "computed",
          label: "siblingFromRoot",
          runtime: "signal-polyfill",
          runtimeMode: "instrumented",
          error: "Boom",
        }),
        makeNode({
          id: 5,
          kind: "state",
          label: "isolated",
          runtime: "custom-rt",
          runtimeMode: "registered",
          live: false,
        }),
      ],
      [
        { sourceId: 1, sinkId: 2 },
        { sourceId: 2, sinkId: 3 },
        { sourceId: 1, sinkId: 4 },
      ],
    );

    const focused = derivePanelViewModel(
      snapshot,
      {
        ...DEFAULT_FILTER_STATE,
        focusSubgraphNodeId: 2,
        query: "runtime:lit-* -runtime:custom-*",
      },
      null,
    );

    expect(focused.focusedNode?.id).toBe(2);
    expect(focused.visibleNodes.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(focused.searchMatchIds).toEqual(new Set([1, 2, 3]));
    expect(focused.runtimeInventory).toEqual([
      {
        name: "lit-signals",
        mode: "registered",
        count: 3,
        excluded: false,
        included: true,
      },
      {
        name: "custom-rt",
        mode: "registered",
        count: 1,
        excluded: true,
        included: false,
      },
      {
        name: "signal-polyfill",
        mode: "instrumented",
        count: 1,
        excluded: false,
        included: false,
      },
    ]);

    // Exclusions work with -kind:, -is:error, -is:cold
    const excl = derivePanelViewModel(
      snapshot,
      {
        ...DEFAULT_FILTER_STATE,
        query: "-kind:watcher -is:error -is:cold",
      },
      null,
    );
    expect(excl.visibleNodes.map((n) => n.id)).toEqual([1, 2]);

    // Runtime query helpers & Filter-mode inclusion->exclusion rewrite
    expect(setRuntimeOnlyInQuery("foo -runtime:worker", "app")).toBe(
      "foo runtime:app",
    );
    expect(clearRuntimeTokens("foo runtime:app")).toBe("foo");
    expect(
      rewriteFieldInclusionsToExclusions(
        "kind:state runtime:app",
        "runtime",
        ["app", "worker"],
        ["app", "worker", "shared"],
      ),
    ).toBe("kind:state -runtime:shared");
  });
});
