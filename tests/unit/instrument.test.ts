import { describe, expect, test } from "bun:test";
import { Signal as RealSignal } from "signal-polyfill";
import { connectSignals } from "../../src/client/index.ts";
import {
  detectInternalSignal,
  extractComputedExpression,
  extractOwnerLabelFromSite,
  inferAutoSignalLabel,
} from "../../src/hook/expression.ts";
import type { SignalEvent } from "../../src/protocol/types.ts";
import { createSignalsHook, GLOBAL_HOOK_KEY } from "../../src/hook/hook.ts";
import { serializePreview } from "../../src/hook/preview.ts";
import {
  parseCallsiteInfo,
  parseDirectCallerStack,
  parseStackLocation,
} from "../../src/hook/stack.ts";

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

  test("resolves V8 <instance_members_initializer> and <static_initializer> frames and extracts ownerLabel", () => {
    const instanceStack = [
      "Error",
      "    at captureCallsite (http://localhost:5173/src/bundle.js:12:5)",
      "    at new InstrumentedState (http://localhost:5173/src/bundle.js:44:10)",
      "    at <instance_members_initializer> (http://localhost:5173/src/cart.ts:18:19)",
      "    at new ShoppingCart (http://localhost:5173/src/cart.ts:14:3)",
    ].join("\n");

    const instLoc = parseStackLocation(instanceStack);
    expect(instLoc).toEqual({
      file: "http://localhost:5173/src/cart.ts",
      line: 18,
      column: 19,
      fn: "new ShoppingCart",
    });
    expect(extractOwnerLabelFromSite(instLoc)).toBe("ShoppingCart");

    const staticStack = [
      "Error",
      "    at captureCallsite (http://localhost:5173/src/bundle.js:12:5)",
      "    at new InstrumentedComputed (http://localhost:5173/src/bundle.js:88:10)",
      "    at <static_initializer> (http://localhost:5173/src/cart.ts:9:24)",
      "    at Object.<anonymous> (http://localhost:5173/src/cart.ts:3:1)",
    ].join("\n");

    const staticLoc = parseStackLocation(staticStack);
    expect(staticLoc).toEqual({
      file: "http://localhost:5173/src/cart.ts",
      line: 9,
      column: 24,
      fn: "Object.<anonymous>",
    });
    expect(extractOwnerLabelFromSite(staticLoc)).toBeNull();

    expect(
      extractOwnerLabelFromSite({
        file: "http://localhost:5173/src/cart.ts",
        line: 22,
        column: 5,
        fn: "CartModel.<instance_members_initializer>",
      }),
    ).toBe("CartModel");
    expect(
      extractOwnerLabelFromSite({
        file: "http://localhost:5173/src/cart.ts",
        line: 5,
        column: 5,
        fn: "CartModel.<static_initializer>",
      }),
    ).toBe("CartModel");
    expect(
      extractOwnerLabelFromSite({
        file: "http://localhost:5173/src/cart.ts",
        line: 5,
        column: 5,
        fn: "Object.createCart",
      }),
    ).toBe("createCart");
  });
});

describe("Wave 2A expression capture, auto-labeling, internal detection, and getTargetFunction", () => {
  test("extracts dedented computeSource (capped at 1200 chars), 1-line computeSignature (120 chars), and autoLabel on unlabeled Computed", () => {
    const hook = createSignalsHook();
    const S = hook.wrap(RealSignal);

    class CartStore {
      price = new S.State(12);
      qty = new S.State(3);
      subtotal = new S.Computed(() => {
        return this.price.get() * this.qty.get();
      });
    }

    const store = new CartStore();
    function computeTax() {
      return store.subtotal.get() * 0.1;
    }
    const tax = new S.Computed(computeTax);
    const computation = () => store.subtotal.get() + 1;
    const genericNameComp = new S.Computed(computation);

    const longComp = new S.Computed(function longCalc() {
      const prefix =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      return store.subtotal.get() + prefix.length;
    });

    expect(store.subtotal.get()).toBe(36);
    expect(tax.get()).toBeCloseTo(3.6);
    expect(genericNameComp.get()).toBe(37);

    const snap = hook.snapshot();
    const subtotalNode = snap.nodes.find(
      (n) =>
        n.kind === "computed" &&
        n.computeSignature?.includes("this.price.get()"),
    );
    expect(subtotalNode).toBeDefined();
    expect(subtotalNode?.label).toBeNull();
    expect(subtotalNode?.ownerLabel).toBe("CartStore");
    expect(subtotalNode?.autoLabel).toBe("this.price.get() * this.qty.get()");
    expect(subtotalNode?.autoLabel?.startsWith("computed · ")).toBe(false);
    expect(subtotalNode?.autoLabel?.startsWith("new ")).toBe(false);
    expect(subtotalNode?.computeSource).toContain(
      "return this.price.get() * this.qty.get();",
    );
    expect(subtotalNode?.computeSignature).not.toContain("\n");

    const priceNode = snap.nodes.find(
      (n) => n.kind === "state" && n.value?.text === "12",
    );
    expect(priceNode?.ownerLabel).toBe("CartStore");
    expect(priceNode?.autoLabel).toBe("CartStore");

    const taxNode = snap.nodes.find((n) => n.autoLabel === "computeTax");
    expect(taxNode).toBeDefined();
    expect(taxNode?.computeSignature).toContain("function computeTax()");

    const genericNode = snap.nodes.find(
      (n) =>
        n.kind === "computed" &&
        n.computeSignature?.includes("store.subtotal.get() + 1"),
    );
    expect(genericNode?.autoLabel).not.toBe("computation");
    expect(genericNode?.autoLabel).toBe("store.subtotal.get() + 1");

    const longNode = snap.nodes.find((n) => n.autoLabel === "longCalc");
    expect(longNode?.computeSource?.length).toBe(1200);
    expect(longNode?.computeSource?.endsWith("…")).toBe(true);
    expect(longNode?.computeSignature?.length).toBe(120);
    expect(longNode?.computeSignature?.endsWith("…")).toBe(true);

    // Direct expression utility edge cases
    expect(extractComputedExpression(Math.max)).toBeNull();
    const wrappedComputation = () => longComp.get();
    expect(extractComputedExpression(wrappedComputation)?.fnName).toBeNull();
    expect(
      inferAutoSignalLabel({
        kind: "computed",
        site: { file: "app.ts", line: 1, column: 1, fn: "new Store" },
        exprFnName: null,
        exprSummary: null,
      }),
    ).toBe("Store");
    expect(longComp).toBeDefined();
  });

  test("populates computeSource, computeSignature, autoLabel, and getTargetFunction for register()-crawled Signal.Computed and Watcher", () => {
    const hook = createSignalsHook();

    const base = new RealSignal.State(5);
    const tripled = new RealSignal.Computed(() => base.get() * 3);
    let dirtyHits = 0;
    function onSignalDirty() {
      dirtyHits += 1;
    }
    const watcher = new RealSignal.subtle.Watcher(onSignalDirty);
    watcher.watch(tripled);
    expect(tripled.get()).toBe(15);
    expect(dirtyHits).toBe(0);

    const handle = hook.register({
      name: "crawled-esm",
      Signal: RealSignal,
      watchers: [watcher],
    });

    const snap = hook.snapshot();
    const compNode = snap.nodes.find((n) => n.kind === "computed");
    const watcherNode = snap.nodes.find((n) => n.kind === "watcher");

    expect(compNode?.runtimeMode).toBe("registered");
    expect(compNode?.computeSignature).toBe("() => base.get() * 3");
    expect(compNode?.computeSource).toContain("base.get() * 3");
    expect(compNode?.autoLabel).toBe("base.get() * 3");
    expect(watcherNode?.autoLabel).toBe("onSignalDirty");

    const targetCompFn = hook.getTargetFunction?.(compNode!.id);
    expect(typeof targetCompFn).toBe("function");
    expect(targetCompFn?.toString()).toContain("base.get() * 3");
    expect(targetCompFn?.name).not.toContain("__SIGNALS_DEVTOOLS__");

    const targetWatcherFn = hook.getTargetFunction?.(watcherNode!.id);
    expect(targetWatcherFn).toBe(onSignalDirty);

    handle.dispose();
  });

  test("detects internal signals (__forceUpdateSignal, @lit-labs/signals) without flagging normal user signals", () => {
    const hook = createSignalsHook();
    const S = hook.wrap(RealSignal);

    const userState = new S.State(1, { name: "userCount" });
    const userComputed = new S.Computed(() => userState.get() + 1, {
      name: "userNext",
    });
    const forceUpdateState = new S.State(0, { name: "__forceUpdateSignal" });
    const signalHost: Record<string, () => void> = {
      __forceUpdate: () => forceUpdateState.set(1),
    };
    const forceUpdateWatcher = new S.subtle.Watcher(() => {
      signalHost["__forceUpdate"]?.();
    });
    expect(S.isWatcher(forceUpdateWatcher)).toBe(true);
    const createInternalFromHelper = () => new S.State(false);
    const prefixedComputed = new S.Computed(() => forceUpdateState.get(), {
      name: "__internalComputed",
    });

    expect(userComputed.get()).toBe(2);
    expect(prefixedComputed.get()).toBe(0);
    expect(createInternalFromHelper().get()).toBe(false);

    const snap = hook.snapshot();
    expect(
      snap.nodes.find((n) => n.label === "userCount")?.internal,
    ).toBeUndefined();
    expect(
      snap.nodes.find((n) => n.label === "userNext")?.internal,
    ).toBeUndefined();
    expect(
      snap.nodes.find((n) => n.label === "__forceUpdateSignal")?.internal,
    ).toBe(true);
    expect(
      snap.nodes.find((n) => n.label === "__internalComputed")?.internal,
    ).toBe(true);
    expect(snap.nodes.find((n) => n.kind === "watcher")?.internal).toBe(true);
    expect(
      snap.nodes.find((n) => n.autoLabel === "createInternalFromHelper")
        ?.internal,
    ).toBeUndefined();

    expect(
      detectInternalSignal({
        label: null,
        site: {
          file: "http://localhost:5173/node_modules/@lit-labs/signals/lib/signal-watcher.js",
          line: 42,
          column: 12,
          fn: "SignalWatcher.performUpdate",
        },
      }),
    ).toBe(true);
    expect(
      detectInternalSignal({
        label: "normal",
        site: {
          file: "http://localhost:5173/src/app.ts",
          line: 10,
          column: 5,
          fn: "App.render",
        },
        fnSource: "() => count.get() * 2",
      }),
    ).toBe(false);
  });

  test("getTargetFunction returns unwrapped user computation/notify and rejects State or [native code] bound functions", () => {
    const hook = createSignalsHook();
    const S = hook.wrap(RealSignal);

    const state = new S.State(10, { name: "state" });
    function rawComputation() {
      return state.get() * 4;
    }
    let notifyCount = 0;
    function rawNotify() {
      notifyCount += 1;
    }
    const boundComputation = rawComputation.bind(null);

    const comp = new S.Computed(rawComputation, { name: "comp" });
    const boundComp = new S.Computed(boundComputation, { name: "boundComp" });
    const watcher = new S.subtle.Watcher(rawNotify);
    hook.label(watcher, "w");

    expect(comp.get()).toBe(40);
    expect(boundComp.get()).toBe(40);
    expect(notifyCount).toBe(0);

    const snap = hook.snapshot();
    const idOf = (name: string) => snap.nodes.find((n) => n.label === name)!.id;

    expect(hook.getTargetFunction?.(idOf("comp"))).toBe(rawComputation);
    expect(hook.getTargetFunction?.(idOf("w"))).toBe(rawNotify);
    expect(hook.getTargetFunction?.(idOf("state"))).toBeNull();
    expect(hook.getTargetFunction?.(idOf("boundComp"))).toBeNull();
    expect(hook.getTargetFunction?.(999999)).toBeNull();
  });

  test("writeStacks captures user caller instead of signalSetFn and detects pre-user @lit-labs/signals frames", () => {
    const hook = createSignalsHook();
    hook.configure({ writeStacks: true });
    const S = hook.wrap(RealSignal);
    const count = new S.State(1, { name: "writeCount" });

    function updateFromUserAction(next: number) {
      count.set(next);
    }
    updateFromUserAction(2);

    const setEvent = hook
      .snapshot()
      .events.find(
        (evt): evt is Extract<SignalEvent, { readonly type: "set" }> =>
          evt.type === "set" && evt.changed,
      );
    expect(setEvent?.site?.fn).toContain("updateFromUserAction");
    expect(setEvent?.site?.fn).not.toBe("signalSetFn");

    // Pre-user @lit-labs/signals frame marks fromInternalPackage = true while attributing site to caller
    const internalStack = [
      "Error",
      "    at SignalWatcher.connectedCallback (http://localhost:5173/node_modules/@lit-labs/signals/lib/signal-watcher.js:42:12)",
      "    at MyWidget.connectedCallback (http://localhost:5173/src/my-widget.ts:15:5)",
    ].join("\n");
    const preInfo = parseCallsiteInfo(internalStack);
    expect(preInfo.fromInternalPackage).toBe(true);
    expect(preInfo.site?.file).toBe("http://localhost:5173/src/my-widget.ts");

    // Vite prebundled @lit-labs_signals.js above user frame also sets fromInternalPackage
    const vitePrebundled = [
      "Error",
      "    at new SignalWatcher (http://localhost:5173/node_modules/.vite/deps/@lit-labs_signals.js:88:3)",
      "    at AppRoot.render (http://localhost:5173/src/app-root.ts:9:3)",
    ].join("\n");
    expect(parseCallsiteInfo(vitePrebundled).fromInternalPackage).toBe(true);

    // @lit-labs/signals BELOW user frame (e.g. user render inside SignalWatcher.performUpdate) must NOT flag
    const userInsidePerformUpdate = [
      "Error",
      "    at UserCard.render (http://localhost:5173/src/user-card.ts:30:9)",
      "    at SignalWatcher.performUpdate (http://localhost:5173/node_modules/@lit-labs/signals/lib/signal-watcher.js:75:12)",
    ].join("\n");
    const userInfo = parseCallsiteInfo(userInsidePerformUpdate);
    expect(userInfo.fromInternalPackage).toBe(false);
    expect(userInfo.site?.fn).toBe("UserCard.render");

    // parseDirectCallerStack strips the virtual set() frame cleanly even if minified
    const minifiedSetStack = [
      "Error",
      "    at e.set (http://localhost:5173/dist/app.min.js:1:400)",
      "    at onSaveClick (http://localhost:5173/src/save.ts:18:7)",
    ].join("\n");
    expect(parseDirectCallerStack(minifiedSetStack)?.fn).toBe("onSaveClick");

    // label() preserves autoLabel on clear and re-evaluates internal flag on rename
    const unnamed = new S.Computed(() => count.get() * 10);
    expect(unnamed.get()).toBe(20);
    const id = hook.snapshot().nodes.find((n) => n.kind === "computed")!.id;
    hook.label(unnamed, "__tempInternal");
    expect(hook.snapshot().nodes.find((n) => n.id === id)?.internal).toBe(true);
    hook.label(unnamed, "publicMetric");
    const renamed = hook.snapshot().nodes.find((n) => n.id === id)!;
    expect(renamed.label).toBe("publicMetric");
    expect(renamed.internal).toBeUndefined();
    hook.label(unnamed, "");
    expect(hook.snapshot().nodes.find((n) => n.id === id)?.autoLabel).toBe(
      "count.get() * 10",
    );
  });
});
