import { describe, expect, test } from "bun:test";
import { Signal as RealSignal } from "signal-polyfill";
import { connectSignals } from "../../src/client/index.ts";
import { createSignalsHook, GLOBAL_HOOK_KEY } from "../../src/hook/hook.ts";
import { serializePreview } from "../../src/hook/preview.ts";
import { parseStackLocation } from "../../src/hook/stack.ts";

describe("SignalsHookEngine with real signal-polyfill", () => {
  test("preserves Signal brands, instanceof, this receivers, and idempotent wrap()", () => {
    const hook = createSignalsHook();
    const Wrapped = hook.wrap(RealSignal);
    expect(hook.wrap(RealSignal)).toBe(Wrapped);
    expect(hook.Signal).toBe(Wrapped);

    const state = new Wrapped.State(10, { name: "counter" });
    let capturedThis: unknown = null;
    const recordThis = (value: unknown) => {
      capturedThis = value;
    };
    const doubled = new Wrapped.Computed(
      function (this: unknown) {
        recordThis(this);
        return state.get() * 2;
      },
      { name: "doubled" },
    );
    const watcher = new Wrapped.subtle.Watcher(() => {});

    expect(Wrapped.isState(state)).toBe(true);
    expect(Wrapped.isComputed(doubled)).toBe(true);
    expect(Wrapped.isWatcher(watcher)).toBe(true);
    expect(RealSignal.isState(state)).toBe(true);
    expect(RealSignal.isComputed(doubled)).toBe(true);
    expect(RealSignal.isWatcher(watcher)).toBe(true);
    expect(state instanceof RealSignal.State).toBe(true);

    const beforeSnap = hook.snapshot();
    const compBefore = beforeSnap.nodes.find((n) => n.label === "doubled");
    expect(compBefore?.unread).toBe(true);
    expect(compBefore?.runs).toBe(0);
    expect(capturedThis).toBeNull();

    expect(doubled.get()).toBe(20);
    expect(capturedThis).toBe(doubled);

    const afterSnap = hook.snapshot();
    const compAfter = afterSnap.nodes.find((n) => n.label === "doubled");
    expect(compAfter?.unread).toBe(false);
    expect(compAfter?.runs).toBe(1);
    expect(compAfter?.value?.text).toBe("20");
    expect(afterSnap.edges).toEqual([
      {
        sourceId: afterSnap.nodes.find((n) => n.label === "counter")!.id,
        sinkId: compAfter!.id,
      },
    ]);
  });

  test("tracks diamond DAG causal attribution and dynamic conditional branch pruning", () => {
    const hook = createSignalsHook();
    const S = hook.wrap(RealSignal);

    const flag = new S.State(true, { name: "flag" });
    const left = new S.State(2, { name: "left" });
    const right = new S.State(100, { name: "right" });

    const branch = new S.Computed(
      () => (flag.get() ? left.get() * 10 : right.get() + 1),
      {
        name: "branch",
      },
    );
    const summary = new S.Computed(() => `val=${branch.get()}`, {
      name: "summary",
    });

    expect(summary.get()).toBe("val=20");

    let snap = hook.snapshot();
    const byLabel = (name: string) => snap.nodes.find((n) => n.label === name)!;
    expect(snap.edges).toContainEqual({
      sourceId: byLabel("flag").id,
      sinkId: byLabel("branch").id,
    });
    expect(snap.edges).toContainEqual({
      sourceId: byLabel("left").id,
      sinkId: byLabel("branch").id,
    });
    expect(snap.edges).not.toContainEqual({
      sourceId: byLabel("right").id,
      sinkId: byLabel("branch").id,
    });

    left.set(3);
    expect(summary.get()).toBe("val=30");

    snap = hook.snapshot();
    expect(byLabel("branch").causes).toEqual([byLabel("left").id]);
    expect(byLabel("summary").causes).toEqual([byLabel("branch").id]);
    expect(byLabel("branch").runs).toBe(2);
    expect(byLabel("summary").runs).toBe(2);

    flag.set(false);
    expect(summary.get()).toBe("val=101");

    snap = hook.snapshot();
    expect(byLabel("branch").causes).toEqual([byLabel("flag").id]);
    expect(snap.edges).toContainEqual({
      sourceId: byLabel("flag").id,
      sinkId: byLabel("branch").id,
    });
    expect(snap.edges).toContainEqual({
      sourceId: byLabel("right").id,
      sinkId: byLabel("branch").id,
    });
    expect(snap.edges).not.toContainEqual({
      sourceId: byLabel("left").id,
      sinkId: byLabel("branch").id,
    });
  });

  test("honors custom equals on State and Computed without double-invoking equals", () => {
    const hook = createSignalsHook();
    const S = hook.wrap(RealSignal);

    let stateEqualsCalls = 0;
    let compEqualsCalls = 0;

    const item = new S.State(
      { id: 1, rev: "a" },
      {
        name: "item",
        equals: (prev, next) => {
          stateEqualsCalls++;
          return prev.id === next.id;
        },
      },
    );

    const bucket = new S.Computed(() => ({ parity: item.get().id % 2 }), {
      name: "bucket",
      equals: (prev, next) => {
        compEqualsCalls++;
        return prev.parity === next.parity;
      },
    });

    const downstream = new S.Computed(() => `parity:${bucket.get().parity}`, {
      name: "downstream",
    });
    expect(downstream.get()).toBe("parity:1");
    expect(compEqualsCalls).toBe(0);

    item.set({ id: 1, rev: "b" });
    expect(stateEqualsCalls).toBe(1);
    expect(downstream.get()).toBe("parity:1");
    expect(
      hook.snapshot().nodes.find((n) => n.label === "downstream")!.runs,
    ).toBe(1);

    item.set({ id: 3, rev: "c" });
    expect(stateEqualsCalls).toBe(2);
    expect(downstream.get()).toBe("parity:1");
    expect(compEqualsCalls).toBe(1);

    // State with equals: () => false records changed: true even when re-setting same reference
    const sharedBox = { count: 1 };
    const mutableState = new S.State(sharedBox, {
      name: "mutableBox",
      equals: () => false,
    });
    const observedCount = new S.Computed(() => mutableState.get().count, {
      name: "observedCount",
    });
    expect(observedCount.get()).toBe(1);
    sharedBox.count = 2;
    mutableState.set(sharedBox);
    expect(observedCount.get()).toBe(2);

    const snap = hook.snapshot();
    expect(snap.nodes.find((n) => n.label === "bucket")!.runs).toBe(2);
    expect(snap.nodes.find((n) => n.label === "downstream")!.runs).toBe(1);
    expect(snap.nodes.find((n) => n.label === "observedCount")?.causes).toEqual(
      [snap.nodes.find((n) => n.label === "mutableBox")!.id],
    );
    const lastBucketRun = snap.events
      .toReversed()
      .find(
        (e) =>
          e.type === "run" &&
          e.nodeId === snap.nodes.find((n) => n.label === "bucket")!.id,
      );
    expect(lastBucketRun?.type === "run" && lastBucketRun.changed).toBe(false);
  });

  test("tracks Watcher live status, causal set-before-notify ordering, getPending, and unwatch transitions", () => {
    const hook = createSignalsHook();
    const S = hook.wrap(RealSignal);

    const count = new S.State(0, { name: "count" });
    const doubled = new S.Computed(() => count.get() * 2, { name: "doubled" });

    let notifications = 0;
    const watcher = new S.subtle.Watcher(() => {
      notifications++;
    });
    hook.label(watcher, "dom-sync");

    expect(hook.snapshot().nodes.find((n) => n.label === "count")!.live).toBe(
      false,
    );
    expect(hook.snapshot().nodes.find((n) => n.label === "doubled")!.live).toBe(
      false,
    );
    expect(
      hook.snapshot().nodes.find((n) => n.label === "dom-sync")!.live,
    ).toBe(false);

    watcher.watch(doubled);
    expect(doubled.get()).toBe(0);

    let snap = hook.snapshot();
    expect(snap.nodes.find((n) => n.label === "count")!.live).toBe(true);
    expect(snap.nodes.find((n) => n.label === "doubled")!.live).toBe(true);
    expect(snap.nodes.find((n) => n.label === "dom-sync")!.live).toBe(true);
    expect(snap.nodes.find((n) => n.label === "dom-sync")!.kind).toBe(
      "watcher",
    );

    count.set(5);
    expect(notifications).toBe(1);
    expect(watcher.getPending()).toEqual([doubled]);

    snap = hook.snapshot();
    const setEvent = snap.events.toReversed().find((e) => e.type === "set");
    const notifyEvent = snap.events.find((e) => e.type === "notify");
    expect(setEvent && notifyEvent && setEvent.seq < notifyEvent.seq).toBe(
      true,
    );
    expect(notifyEvent?.type === "notify" && notifyEvent.pendingIds).toEqual([
      snap.nodes.find((n) => n.label === "doubled")!.id,
    ]);

    expect(doubled.get()).toBe(10);
    watcher.unwatch(doubled);

    snap = hook.snapshot();
    expect(snap.nodes.find((n) => n.label === "count")!.live).toBe(false);
    expect(snap.nodes.find((n) => n.label === "doubled")!.live).toBe(false);
    expect(snap.nodes.find((n) => n.label === "dom-sync")!.live).toBe(false);
  });

  test("records Computed errors, recovery, setValue(), and evaluate() actions", () => {
    const hook = createSignalsHook();
    const S = hook.wrap(RealSignal);

    const divisor = new S.State(0, { name: "divisor" });
    const ratio = new S.Computed(
      () => {
        const d = divisor.get();
        if (d === 0) throw new Error("Divide by zero");
        return 100 / d;
      },
      { name: "ratio" },
    );
    expect(S.isComputed(ratio)).toBe(true);

    const ratioId = hook.snapshot().nodes.find((n) => n.label === "ratio")!.id;
    const evalRes = hook.evaluate(ratioId);
    expect(evalRes.ok).toBe(false);

    let snap = hook.snapshot();
    const ratioNode = snap.nodes.find((n) => n.id === ratioId)!;
    expect(ratioNode.error).toBe("Error: Divide by zero");
    expect(ratioNode.runs).toBe(1);
    expect(
      snap.events.some((e) => e.type === "error" && e.nodeId === ratioId),
    ).toBe(true);

    const divisorId = snap.nodes.find((n) => n.label === "divisor")!.id;
    expect(hook.setValue(divisorId, "not-json").ok).toBe(false);
    expect(hook.setValue(divisorId, "4")).toEqual({ ok: true });
    expect(hook.evaluate(ratioId)).toEqual({ ok: true });

    snap = hook.snapshot();
    const recovered = snap.nodes.find((n) => n.id === ratioId)!;
    expect(recovered.error).toBeNull();
    expect(recovered.value?.text).toBe("25");
  });

  test("discovers un-instrumented private copy via register() without #brand collisions or clearing getPending()", () => {
    const hook = createSignalsHook();

    const price = new RealSignal.State(10);
    const total = new RealSignal.Computed(() => price.get() * 3);
    const watcher = new RealSignal.subtle.Watcher(() => {});
    watcher.watch(total);
    expect(total.get()).toBe(30);

    hook.label(price, "price");
    hook.label(total, "total");
    hook.label(watcher, "cart-watcher");

    const handle = hook.register({
      name: "private-esm",
      Signal: RealSignal,
      watchers: [watcher],
    });

    // Mutate price -> snapshot() must NOT call total.get() passively or clear watcher.getPending()!
    price.set(20);
    let snap = hook.snapshot();
    expect(snap.runtimes).toEqual([
      { name: "private-esm", mode: "registered" },
    ]);
    expect(snap.nodes.find((n) => n.label === "price")?.value?.text).toBe("20");
    expect(watcher.getPending()).toEqual([total]);
    expect(snap.edges.length).toBe(2);

    // Explicit evaluate() reads the computed cleanly
    const totalId = snap.nodes.find((n) => n.label === "total")!.id;
    expect(hook.evaluate(totalId)).toEqual({ ok: true });
    snap = hook.snapshot();
    expect(snap.nodes.find((n) => n.id === totalId)?.value?.text).toBe("60");

    handle.dispose();
    snap = hook.snapshot();
    expect(snap.nodes.length).toBe(0);
    expect(snap.runtimes.length).toBe(0);
  });

  test("connectSignals uses caller runtimeName without leaking an unused client runtime", () => {
    const hook = createSignalsHook();
    const host = globalThis as Record<string, unknown>;
    const prev = host[GLOBAL_HOOK_KEY];
    host[GLOBAL_HOOK_KEY] = hook;
    try {
      const AppSignal = connectSignals(RealSignal, "custom-runtime");
      const count = new AppSignal.State(42, { name: "appCount" });
      expect(count.get()).toBe(42);
      const snap = hook.snapshot();
      expect(snap.runtimes).toEqual([
        { name: "custom-runtime", mode: "instrumented" },
      ]);
      expect(snap.nodes[0]?.runtime).toBe("custom-runtime");
    } finally {
      if (prev === undefined) delete host[GLOBAL_HOOK_KEY];
      else host[GLOBAL_HOOK_KEY] = prev;
    }
  });

  test("supports clearEvents(), incremental sinceSeq, and paused recording", () => {
    const hook = createSignalsHook();
    const S = hook.wrap(RealSignal);
    const s = new S.State(1, { name: "s" });
    const full = hook.snapshot();
    expect(full.events.length).toBe(1);

    s.set(2);
    const inc = hook.snapshot(full.seq);
    expect(inc.events.length).toBe(1);
    expect(inc.events[0]?.type).toBe("set");

    hook.configure({ paused: true });
    s.set(3);
    expect(hook.snapshot(inc.seq).events.length).toBe(0);

    hook.clearEvents();
    expect(hook.snapshot().events.length).toBe(0);
  });
});

describe("serializePreview & parseStackLocation", () => {
  test("handles primitives, BigInt, Symbols, cyclic objects, Map, Set, and throwing getters", () => {
    expect(serializePreview(undefined)).toEqual({
      kind: "undefined",
      text: "undefined",
    });
    expect(serializePreview(-0)).toEqual({ kind: "number", text: "-0" });
    expect(serializePreview(42n)).toEqual({ kind: "bigint", text: "42n" });
    expect(serializePreview(Symbol("tok"))).toEqual({
      kind: "symbol",
      text: "Symbol(tok)",
    });

    // Strings truncated at 44 chars must preserve truncated: true
    const longStrPreview = serializePreview("a".repeat(60));
    expect(longStrPreview.kind).toBe("string");
    expect(longStrPreview.truncated).toBe(true);

    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const cyclicPreview = serializePreview(cyclic);
    expect(cyclicPreview.kind).toBe("object");
    expect(cyclicPreview.text).toContain("[Circular]");

    const throwingObj = {
      get boom(): never {
        throw new Error("bad getter");
      },
    };
    const throwingPreview = serializePreview(throwingObj);
    expect(throwingPreview.entries?.[0]?.[1]).toContain("[Throws: bad getter]");

    const mapPreview = serializePreview(new Map([["a", 1]]));
    expect(mapPreview.kind).toBe("map");
    expect(mapPreview.text).toBe("Map(1)");

    const setPreview = serializePreview(new Set([1, 2, 3]));
    expect(setPreview.kind).toBe("set");
    expect(setPreview.text).toBe("Set(3)");
  });

  test("parses V8 stack frames and skips ignored patterns", () => {
    const sampleStack = [
      "Error",
      "    at captureCallsite (chrome-extension://abc/hook.js:12:5)",
      "    at new InstrumentedState (chrome-extension://abc/hook.js:44:10)",
      "    at createStore (http://localhost:5173/node_modules/pkg/index.js:8:1)",
      "    at mountApp (http://localhost:5173/src/app.ts:42:17)",
    ].join("\n");

    const loc = parseStackLocation(sampleStack, [
      /\/node_modules\//,
      /^chrome-extension:\/\//,
    ]);
    expect(loc).toEqual({
      file: "http://localhost:5173/src/app.ts",
      line: 42,
      column: 17,
      fn: "mountApp",
    });
  });
});
