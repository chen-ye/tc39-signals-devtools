import { describe, expect, test } from "bun:test";
import { Signal as RealSignal } from "signal-polyfill";
import { createSignalsHook } from "../../src/hook/hook.ts";
import {
  DEFAULT_FILTER_STATE,
  derivePanelViewModel,
} from "../../src/panel/graph-state.ts";

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
});
