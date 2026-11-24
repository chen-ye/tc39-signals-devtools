import type {
  ActionResult,
  GraphSnapshot,
  HookSettings,
  RuntimeHandle,
  RuntimeInfo,
  RuntimeMode,
  RuntimeRegistration,
  SignalComputedInstance,
  SignalEdgeSnapshot,
  SignalEvent,
  SignalKind,
  SignalNamespace,
  SignalNodeSnapshot,
  SignalOptions,
  SignalStateInstance,
  SignalWatcherInstance,
  SourceLocation,
  ValuePreview,
} from "../protocol/types.ts";
import { formatErrorMessage, serializePreview } from "./preview.ts";
import {
  detectInternalSignal,
  extractComputedExpression,
  extractOwnerLabelFromSite,
  getFunctionSource,
  inferAutoSignalLabel,
} from "./expression.ts";
import {
  captureCallsite,
  captureCallsiteInfo,
  compileIgnoreMatchers,
  parseDirectCallerStack,
} from "./stack.ts";

const MAX_EVENT_HISTORY = 500;

type TargetFn = (...args: never[]) => unknown;

function isTargetFn(value: unknown): value is TargetFn {
  return typeof value === "function";
}

function asTargetFn(value: unknown): TargetFn | null {
  return isTargetFn(value) ? value : null;
}

function isDevtoolsWrapperFn(fn: TargetFn): boolean {
  if (fn.name.includes("__SIGNALS_DEVTOOLS__")) return true;
  try {
    return Function.prototype.toString
      .call(fn)
      .includes("__SIGNALS_DEVTOOLS__");
  } catch {
    return false;
  }
}

function extractPolyfillTargetFunction(
  instance: object,
  kind: "computed" | "watcher",
): TargetFn | null {
  try {
    const propName =
      kind === "computed" ? "computation" : "consumerMarkedDirty";
    for (const sym of Object.getOwnPropertySymbols(instance)) {
      const internalNode: unknown = Reflect.get(instance, sym);
      if (internalNode === null || typeof internalNode !== "object") {
        continue;
      }
      const candidate: unknown = Reflect.get(internalNode, propName);
      const fn = asTargetFn(candidate);
      if (fn && !isDevtoolsWrapperFn(fn)) {
        return fn;
      }
    }
  } catch {
    // Defensive: inspecting foreign signal internals must never throw
  }
  return null;
}

function buildRegisteredComputedCreateMeta(instance: object) {
  const rawFn = extractPolyfillTargetFunction(instance, "computed");
  const expr = rawFn ? extractComputedExpression(rawFn) : null;
  const rawFnSource = expr?.source ?? getFunctionSource(rawFn);
  const autoLabel = inferAutoSignalLabel({
    kind: "computed",
    site: null,
    exprFnName: expr?.fnName ?? null,
    exprSummary: expr?.summary ?? null,
  });
  const internal = detectInternalSignal({
    label: null,
    site: null,
    fnSource: rawFnSource,
  });
  return {
    autoLabel,
    computeSource: expr?.source ?? null,
    computeSignature: expr?.signature ?? null,
    internal,
    ...(rawFn ? { targetFnRef: new WeakRef(rawFn) } : {}),
  };
}

function buildRegisteredWatcherCreateMeta(instance: object) {
  const rawNotify = extractPolyfillTargetFunction(instance, "watcher");
  const notifyExpr = rawNotify ? extractComputedExpression(rawNotify) : null;
  const notifySource = notifyExpr?.source ?? getFunctionSource(rawNotify);
  const autoLabel = inferAutoSignalLabel({
    kind: "watcher",
    site: null,
    exprFnName: notifyExpr?.fnName ?? null,
  });
  const internal = detectInternalSignal({
    label: null,
    site: null,
    fnSource: notifySource,
  });
  return {
    autoLabel,
    internal,
    ...(rawNotify ? { targetFnRef: new WeakRef(rawNotify) } : {}),
  };
}

interface BaseNodeRecord {
  readonly id: number;
  readonly kind: SignalKind;
  label: string | null;
  autoLabel?: string | null;
  ownerLabel?: string | null;
  computeSource?: string | null;
  computeSignature?: string | null;
  internal?: boolean;
  fromInternalPackage?: boolean;
  targetFnRef?: WeakRef<TargetFn>;
  readonly runtime: string;
  readonly runtimeMode: RuntimeMode;
  readonly signalApi: SignalNamespace;
  readonly site: SourceLocation | null;
  valuePreview: ValuePreview | null;
  error: string | null;
  unread: boolean;
  live: boolean;
  sets: number;
  runs: number;
  notifies: number;
  lastRunMs: number | null;
  changeSeq: number;
  lastChangedSeq: number;
  causes: ReadonlyArray<number>;
  sourceIds: ReadonlyArray<number>;
  lastSeenSourceSeq: Map<number, number>;
  erroredLastRun: boolean;
}

interface StateNodeRecord extends BaseNodeRecord {
  readonly kind: "state";
  readonly ref: WeakRef<SignalStateInstance>;
}

interface ComputedNodeRecord extends BaseNodeRecord {
  readonly kind: "computed";
  readonly ref: WeakRef<SignalComputedInstance>;
}

interface WatcherNodeRecord extends BaseNodeRecord {
  readonly kind: "watcher";
  readonly ref: WeakRef<SignalWatcherInstance>;
}

type NodeRecord = StateNodeRecord | ComputedNodeRecord | WatcherNodeRecord;

interface PendingComputedEval {
  readonly startMs: number;
  readonly first: boolean;
  readonly causes: ReadonlyArray<number>;
  readonly prevWasValid: boolean;
  readonly prevRawValue: unknown;
  equalsChecked: boolean;
}

interface PendingWriteSiteEntry {
  readonly site: SourceLocation | null;
}

interface RegisteredRuntimeEntry {
  readonly id: number;
  readonly name: string;
  readonly signalApi: SignalNamespace;
  readonly watchers: Set<WeakRef<SignalWatcherInstance>>;
}

type CreateRecordParams =
  | {
      readonly kind: "state";
      readonly instance: SignalStateInstance;
      readonly label: string | null;
      readonly autoLabel?: string | null;
      readonly ownerLabel?: string | null;
      readonly computeSource?: string | null;
      readonly computeSignature?: string | null;
      readonly internal?: boolean;
      readonly fromInternalPackage?: boolean;
      readonly targetFnRef?: WeakRef<TargetFn>;
      readonly runtime: string;
      readonly runtimeMode: RuntimeMode;
      readonly signalApi: SignalNamespace;
      readonly site: SourceLocation | null;
      readonly initialPreview: ValuePreview | null;
      readonly unread: boolean;
    }
  | {
      readonly kind: "computed";
      readonly instance: SignalComputedInstance;
      readonly label: string | null;
      readonly autoLabel?: string | null;
      readonly ownerLabel?: string | null;
      readonly computeSource?: string | null;
      readonly computeSignature?: string | null;
      readonly internal?: boolean;
      readonly fromInternalPackage?: boolean;
      readonly targetFnRef?: WeakRef<TargetFn>;
      readonly runtime: string;
      readonly runtimeMode: RuntimeMode;
      readonly signalApi: SignalNamespace;
      readonly site: SourceLocation | null;
      readonly initialPreview: ValuePreview | null;
      readonly unread: boolean;
    }
  | {
      readonly kind: "watcher";
      readonly instance: SignalWatcherInstance;
      readonly label: string | null;
      readonly autoLabel?: string | null;
      readonly ownerLabel?: string | null;
      readonly computeSource?: string | null;
      readonly computeSignature?: string | null;
      readonly internal?: boolean;
      readonly fromInternalPackage?: boolean;
      readonly targetFnRef?: WeakRef<TargetFn>;
      readonly runtime: string;
      readonly runtimeMode: RuntimeMode;
      readonly signalApi: SignalNamespace;
      readonly site: SourceLocation | null;
      readonly initialPreview: ValuePreview | null;
      readonly unread: boolean;
    };

interface InstrumentationCallbacks {
  getIgnoreMatchers(): ReadonlyArray<RegExp>;
  getSettings(): HookSettings;
  nextSeq(): number;
  createRecord(params: CreateRecordParams): NodeRecord;
  getRecord(instance: object): NodeRecord | undefined;
  getNodeId(instance: object): number | undefined;
  computeCauses(record: NodeRecord): ReadonlyArray<number>;
  finalizeComputedRun(
    record: NodeRecord,
    pending: PendingComputedEval,
    value: unknown,
    changed: boolean,
  ): void;
  markPendingComputedError(
    record: NodeRecord,
    causes: ReadonlyArray<number>,
    startMs: number,
    err: unknown,
  ): void;
  setPendingEval(target: object, pending: PendingComputedEval): void;
  takePendingEval(target: object): PendingComputedEval | undefined;
  pushPendingWriteSite(target: object, entry: PendingWriteSiteEntry): void;
  consumePendingWriteSite(target: object): PendingWriteSiteEntry | undefined;
  popPendingWriteSite(target: object, entry: PendingWriteSiteEntry): void;
  flushPendingSourceSync(): void;
  syncNodeSources(
    record: NodeRecord,
    instance: SignalComputedInstance | SignalWatcherInstance,
  ): void;
  refreshLiveFlags(signalApi: SignalNamespace): void;
  pushEvent(event: SignalEvent): void;
  scheduleNotify(): void;
}

function buildInstrumentedNamespace(
  signalApi: SignalNamespace,
  runtimeName: string,
  cb: InstrumentationCallbacks,
): SignalNamespace {
  const baseSubtle = signalApi.subtle;

  class InstrumentedState<V> extends signalApi.State<V> {
    constructor(initialValue: V, options?: SignalOptions<V>) {
      const userEquals = options?.equals;
      const wrappedOptions: SignalOptions<V> = {
        ...options,
        equals: function __SIGNALS_DEVTOOLS__stateEquals(
          this: unknown,
          prev: V,
          next: V,
        ): boolean {
          const target =
            typeof this === "object" && this !== null ? this : undefined;
          const pendingWrite = target
            ? cb.consumePendingWriteSite(target)
            : undefined;
          const writeSite = pendingWrite
            ? pendingWrite.site
            : cb.getSettings().writeStacks
              ? captureCallsite(cb.getIgnoreMatchers(), 0)
              : null;

          const isEqual = userEquals
            ? Reflect.apply(userEquals, this, [prev, next])
            : Object.is(prev, next);

          const record = target ? cb.getRecord(target) : undefined;
          if (record) {
            const changed = !isEqual;
            const fromPreview = serializePreview(prev);
            const toPreview = serializePreview(changed ? next : prev);
            const seq = cb.nextSeq();

            record.sets += 1;
            if (changed) {
              record.valuePreview = toPreview;
              record.changeSeq = seq;
              record.lastChangedSeq = seq;
            }

            cb.pushEvent({
              seq,
              timestamp: Date.now(),
              type: "set",
              nodeId: record.id,
              from: fromPreview,
              to: toPreview,
              changed,
              site: writeSite,
            });
            cb.scheduleNotify();
          }

          return isEqual;
        },
      };

      super(initialValue, wrappedOptions);
      const label =
        typeof options?.name === "string" && options.name.trim()
          ? options.name.trim()
          : null;
      const { site, fromInternalPackage } = captureCallsiteInfo(
        cb.getIgnoreMatchers(),
        0,
      );
      const ownerLabel = extractOwnerLabelFromSite(site);
      const autoLabel = inferAutoSignalLabel({ kind: "state", site });
      const internal = detectInternalSignal({
        label,
        site,
        fromInternalPackage,
      });
      const record = cb.createRecord({
        instance: this,
        kind: "state",
        label,
        autoLabel,
        ownerLabel,
        internal,
        fromInternalPackage,
        runtime: runtimeName,
        runtimeMode: "instrumented",
        signalApi,
        site,
        initialPreview: serializePreview(initialValue),
        unread: false,
      });
      record.live = safeHasSinks(signalApi, this);
      cb.pushEvent({
        seq: cb.nextSeq(),
        timestamp: Date.now(),
        type: "create",
        nodeId: record.id,
        kind: "state",
        label: record.label,
      });
      cb.scheduleNotify();
    }

    override set(newValue: V): void {
      let writeEntry: PendingWriteSiteEntry | null = null;
      if (cb.getSettings().writeStacks) {
        const callerSite = parseDirectCallerStack(
          new Error().stack,
          cb.getIgnoreMatchers(),
        );
        writeEntry = { site: callerSite };
        cb.pushPendingWriteSite(this, writeEntry);
      }
      try {
        super.set(newValue);
      } finally {
        if (writeEntry) {
          cb.popPendingWriteSite(this, writeEntry);
        }
      }
      const record = cb.getRecord(this);
      if (record) {
        record.live = safeHasSinks(signalApi, this);
      }
    }
  }

  class InstrumentedComputed<V> extends signalApi.Computed<V> {
    constructor(computation: () => V, options?: SignalOptions<V>) {
      let lastRawValue: unknown = undefined;
      let hasValidLastValue = false;
      const userEquals = options?.equals;
      const expr = extractComputedExpression(computation);
      const rawComputation = asTargetFn(computation);
      const rawComputationSource =
        expr?.source ?? getFunctionSource(computation);

      const wrappedComputation = function __SIGNALS_DEVTOOLS__computedFn(
        this: unknown,
      ): V {
        const target =
          typeof this === "object" && this !== null ? this : undefined;
        const record = target ? cb.getRecord(target) : undefined;
        const startMs = performance.now();

        if (!record || !target) {
          return computation.call(this);
        }

        const first = record.unread;
        const causes = first ? [] : cb.computeCauses(record);

        const pending: PendingComputedEval = {
          startMs,
          first,
          causes,
          prevWasValid: hasValidLastValue && !record.erroredLastRun,
          prevRawValue: lastRawValue,
          equalsChecked: false,
        };
        cb.setPendingEval(target, pending);

        let result: V;
        try {
          result = computation.call(this);
        } catch (err) {
          cb.takePendingEval(target);
          hasValidLastValue = false;
          lastRawValue = undefined;
          cb.markPendingComputedError(record, causes, startMs, err);
          throw err;
        }

        if (userEquals && pending.prevWasValid) {
          return result;
        }

        cb.takePendingEval(target);
        const changed =
          !pending.prevWasValid || !Object.is(pending.prevRawValue, result);
        lastRawValue = result;
        hasValidLastValue = true;
        cb.finalizeComputedRun(record, pending, result, changed);
        return result;
      };

      const wrappedOptions: SignalOptions<V> | undefined = options
        ? {
            ...options,
            ...(userEquals
              ? {
                  equals: function __SIGNALS_DEVTOOLS__computedEquals(
                    this: unknown,
                    prev: V,
                    next: V,
                  ): boolean {
                    const target =
                      typeof this === "object" && this !== null
                        ? this
                        : undefined;
                    const record = target ? cb.getRecord(target) : undefined;
                    const pending = target
                      ? cb.takePendingEval(target)
                      : undefined;
                    let eq: boolean;
                    try {
                      eq = userEquals.call(this, prev, next);
                    } catch (err) {
                      if (record && pending) {
                        hasValidLastValue = false;
                        lastRawValue = undefined;
                        cb.markPendingComputedError(
                          record,
                          pending.causes,
                          pending.startMs,
                          err,
                        );
                      }
                      throw err;
                    }
                    if (record && pending && !pending.equalsChecked) {
                      pending.equalsChecked = true;
                      if (!eq) {
                        lastRawValue = next;
                        hasValidLastValue = true;
                      }
                      cb.finalizeComputedRun(
                        record,
                        pending,
                        eq ? prev : next,
                        !eq,
                      );
                    }
                    return eq;
                  },
                }
              : {}),
          }
        : undefined;

      super(wrappedComputation, wrappedOptions);

      const label =
        typeof options?.name === "string" && options.name.trim()
          ? options.name.trim()
          : null;
      const { site, fromInternalPackage } = captureCallsiteInfo(
        cb.getIgnoreMatchers(),
        0,
      );
      const ownerLabel = extractOwnerLabelFromSite(site);
      const autoLabel = inferAutoSignalLabel({
        kind: "computed",
        site,
        exprFnName: expr?.fnName ?? null,
        exprSummary: expr?.summary ?? null,
      });
      const internal = detectInternalSignal({
        label,
        site,
        fnSource: rawComputationSource,
        fromInternalPackage,
      });
      const record = cb.createRecord({
        instance: this,
        kind: "computed",
        label,
        autoLabel,
        ownerLabel,
        computeSource: expr?.source ?? null,
        computeSignature: expr?.signature ?? null,
        internal,
        fromInternalPackage,
        ...(rawComputation ? { targetFnRef: new WeakRef(rawComputation) } : {}),
        runtime: runtimeName,
        runtimeMode: "instrumented",
        signalApi,
        site,
        initialPreview: null,
        unread: true,
      });
      cb.pushEvent({
        seq: cb.nextSeq(),
        timestamp: Date.now(),
        type: "create",
        nodeId: record.id,
        kind: "computed",
        label: record.label,
      });
      cb.scheduleNotify();
    }

    override get(): V {
      try {
        return super.get();
      } finally {
        cb.flushPendingSourceSync();
        const record = cb.getRecord(this);
        if (record) {
          cb.syncNodeSources(record, this);
        }
      }
    }
  }

  class InstrumentedWatcher extends baseSubtle.Watcher {
    constructor(notify: () => void) {
      const rawNotify = asTargetFn(notify);
      const notifyExpr = extractComputedExpression(notify);
      const notifySource = notifyExpr?.source ?? getFunctionSource(notify);

      const wrappedNotify = function __SIGNALS_DEVTOOLS__watcherNotify(
        this: SignalWatcherInstance,
      ): void {
        const record = cb.getRecord(this);
        if (record) {
          record.notifies += 1;
          const pendingIds: number[] = [];
          try {
            for (const pending of this.getPending()) {
              const pendingId = cb.getNodeId(pending);
              if (pendingId !== undefined) {
                pendingIds.push(pendingId);
              }
            }
          } catch {
            // Defensive: getPending never reads signals
          }
          const seq = cb.nextSeq();
          record.lastChangedSeq = seq;
          cb.pushEvent({
            seq,
            timestamp: Date.now(),
            type: "notify",
            nodeId: record.id,
            pendingIds,
          });
          cb.scheduleNotify();
        }
        notify.call(this);
      };

      super(wrappedNotify);

      const { site, fromInternalPackage } = captureCallsiteInfo(
        cb.getIgnoreMatchers(),
        0,
      );
      const ownerLabel = extractOwnerLabelFromSite(site);
      const autoLabel = inferAutoSignalLabel({
        kind: "watcher",
        site,
        exprFnName: notifyExpr?.fnName ?? null,
      });
      const internal = detectInternalSignal({
        label: null,
        site,
        fnSource: notifySource,
        fromInternalPackage,
      });
      const record = cb.createRecord({
        instance: this,
        kind: "watcher",
        label: null,
        autoLabel,
        ownerLabel,
        internal,
        fromInternalPackage,
        ...(rawNotify ? { targetFnRef: new WeakRef(rawNotify) } : {}),
        runtime: runtimeName,
        runtimeMode: "instrumented",
        signalApi,
        site,
        initialPreview: null,
        unread: false,
      });
      record.live = false;
      cb.pushEvent({
        seq: cb.nextSeq(),
        timestamp: Date.now(),
        type: "create",
        nodeId: record.id,
        kind: "watcher",
        label: record.label,
      });
      cb.scheduleNotify();
    }

    override watch(
      ...signals: Array<SignalStateInstance | SignalComputedInstance>
    ): void {
      super.watch(...signals);
      const record = cb.getRecord(this);
      if (record) {
        cb.syncNodeSources(record, this);
        record.live = safeHasSources(signalApi, this);
        cb.refreshLiveFlags(signalApi);
        cb.scheduleNotify();
      }
    }

    override unwatch(
      ...signals: Array<SignalStateInstance | SignalComputedInstance>
    ): void {
      super.unwatch(...signals);
      const record = cb.getRecord(this);
      if (record) {
        cb.syncNodeSources(record, this);
        record.live = safeHasSources(signalApi, this);
        cb.refreshLiveFlags(signalApi);
        cb.scheduleNotify();
      }
    }
  }

  return {
    State: InstrumentedState,
    Computed: InstrumentedComputed,
    isState: (value: unknown) => signalApi.isState(value),
    isComputed: (value: unknown) => signalApi.isComputed(value),
    isWatcher: (value: unknown) => signalApi.isWatcher(value),
    subtle: {
      untrack: <R>(fn: () => R) => baseSubtle.untrack(fn),
      currentComputed: () => baseSubtle.currentComputed(),
      introspectSources: (sink) => baseSubtle.introspectSources(sink),
      introspectSinks: (sig) => baseSubtle.introspectSinks(sig),
      hasSinks: (sig) => baseSubtle.hasSinks(sig),
      hasSources: (sink) => baseSubtle.hasSources(sink),
      Watcher: InstrumentedWatcher,
      watched: baseSubtle.watched,
      unwatched: baseSubtle.unwatched,
    },
  };
}

export class SignalsHookEngine {
  #nextNodeId = 1;
  #nextRuntimeId = 1;
  #seq = 0;
  #baseSeq = 0;
  #droppedEvents = 0;
  #inSnapshotRead = false;

  #settings: HookSettings = {
    writeStacks: false,
    paused: false,
  };

  #ignorePatterns: string[] = [];
  #ignoreMatchers: ReadonlyArray<RegExp> = compileIgnoreMatchers([]);

  readonly #nodesById = new Map<number, NodeRecord>();
  readonly #idByObject = new WeakMap<object, number>();
  readonly #deferredLabels = new WeakMap<object, string | null>();
  readonly #rawByWrapped = new WeakMap<SignalNamespace, SignalNamespace>();
  readonly #wrappedByRawAndName = new WeakMap<
    SignalNamespace,
    Map<string, SignalNamespace>
  >();
  readonly #runtimes = new Map<string, RuntimeInfo>();
  readonly #registeredRuntimes = new Map<number, RegisteredRuntimeEntry>();
  readonly #pendingSourceSync = new Set<number>();
  readonly #pendingComputedEvals = new WeakMap<object, PendingComputedEval>();
  readonly #pendingWriteSites = new WeakMap<object, PendingWriteSiteEntry[]>();
  readonly #events: SignalEvent[] = [];
  readonly #listeners = new Set<() => void>();

  #notifyScheduled = false;
  #primarySignal: SignalNamespace | null = null;

  readonly #finalizer = new FinalizationRegistry<number>((nodeId) => {
    const existing = this.#nodesById.get(nodeId);
    if (existing && existing.ref.deref() === undefined) {
      this.#nodesById.delete(nodeId);
      this.#pendingSourceSync.delete(nodeId);
      this.#scheduleNotify();
    }
  });

  readonly #callbacks: InstrumentationCallbacks = {
    getIgnoreMatchers: () => this.#ignoreMatchers,
    getSettings: () => this.#settings,
    nextSeq: () => ++this.#seq,
    createRecord: (params) => this.#createRecord(params),
    getRecord: (instance) => this.#getRecord(instance),
    getNodeId: (instance) => this.#idByObject.get(instance),
    computeCauses: (record) => this.#computeCauses(record),
    finalizeComputedRun: (record, pending, value, changed) =>
      this.#finalizeComputedRun(record, pending, value, changed),
    markPendingComputedError: (record, causes, startMs, err) =>
      this.#markPendingComputedError(record, causes, startMs, err),
    setPendingEval: (target, pending) => {
      this.#pendingComputedEvals.set(target, pending);
    },
    takePendingEval: (target) => {
      const pending = this.#pendingComputedEvals.get(target);
      this.#pendingComputedEvals.delete(target);
      return pending;
    },
    pushPendingWriteSite: (target, entry) => {
      const stack = this.#pendingWriteSites.get(target);
      if (stack) {
        stack.push(entry);
      } else {
        this.#pendingWriteSites.set(target, [entry]);
      }
    },
    consumePendingWriteSite: (target) => {
      const stack = this.#pendingWriteSites.get(target);
      if (!stack || stack.length === 0) return undefined;
      const entry = stack.pop();
      if (stack.length === 0) {
        this.#pendingWriteSites.delete(target);
      }
      return entry;
    },
    popPendingWriteSite: (target, entry) => {
      const stack = this.#pendingWriteSites.get(target);
      if (!stack || stack.length === 0) return;
      if (stack[stack.length - 1] === entry) {
        stack.pop();
        if (stack.length === 0) {
          this.#pendingWriteSites.delete(target);
        }
      }
    },
    flushPendingSourceSync: () => this.#flushPendingSourceSync(),
    syncNodeSources: (record, instance) =>
      this.#syncNodeSources(record, instance),
    refreshLiveFlags: (signalApi) => this.#refreshLiveFlags(signalApi),
    pushEvent: (event) => this.#pushEvent(event),
    scheduleNotify: () => this.#scheduleNotify(),
  };

  get primarySignal(): SignalNamespace | null {
    return this.#primarySignal;
  }

  wrap(signalApi: SignalNamespace, runtimeName = "global"): SignalNamespace {
    const rawApi = this.#rawByWrapped.get(signalApi) ?? signalApi;
    let byRuntime = this.#wrappedByRawAndName.get(rawApi);
    if (!byRuntime) {
      byRuntime = new Map<string, SignalNamespace>();
      this.#wrappedByRawAndName.set(rawApi, byRuntime);
    }

    const existing = byRuntime.get(runtimeName);
    if (existing) {
      return existing;
    }

    const wrappedNamespace = buildInstrumentedNamespace(
      rawApi,
      runtimeName,
      this.#callbacks,
    );
    byRuntime.set(runtimeName, wrappedNamespace);
    this.#rawByWrapped.set(wrappedNamespace, rawApi);
    if (!this.#primarySignal) {
      this.#primarySignal = wrappedNamespace;
    }
    return wrappedNamespace;
  }

  register(registration: RuntimeRegistration): RuntimeHandle {
    const id = this.#nextRuntimeId++;
    const watchers = new Set<WeakRef<SignalWatcherInstance>>();
    for (const watcher of registration.watchers ?? []) {
      watchers.add(new WeakRef(watcher));
    }
    const entry: RegisteredRuntimeEntry = {
      id,
      name: registration.name,
      signalApi: registration.Signal,
      watchers,
    };
    this.#registeredRuntimes.set(id, entry);
    this.#runtimes.set(registration.name, {
      name: registration.name,
      mode: "registered",
    });
    this.#crawlRegisteredRuntime(entry);
    this.#scheduleNotify();

    return {
      addWatcher: (watcher: SignalWatcherInstance) => {
        if (!this.#registeredRuntimes.has(id)) return;
        entry.watchers.add(new WeakRef(watcher));
        this.#crawlRegisteredRuntime(entry);
        this.#scheduleNotify();
      },
      dispose: () => {
        this.#registeredRuntimes.delete(id);
        for (const [nodeId, record] of this.#nodesById.entries()) {
          if (
            record.runtime === entry.name &&
            record.runtimeMode === "registered"
          ) {
            this.#nodesById.delete(nodeId);
            this.#pendingSourceSync.delete(nodeId);
          }
        }
        const stillHasRuntime = Array.from(
          this.#registeredRuntimes.values(),
        ).some((r) => r.name === entry.name);
        if (!stillHasRuntime) {
          this.#runtimes.delete(entry.name);
        }
        this.#scheduleNotify();
      },
    };
  }

  label<T extends object>(target: T, name: string): T {
    const clean = name.trim();
    const record = this.#getRecord(target);
    if (record) {
      record.label = clean.length > 0 ? clean : null;
      record.internal = detectInternalSignal({
        label: record.label,
        site: record.site,
        fnSource:
          record.computeSource ??
          getFunctionSource(record.targetFnRef?.deref()),
        ...(record.fromInternalPackage !== undefined
          ? { fromInternalPackage: record.fromInternalPackage }
          : {}),
      });
      this.#scheduleNotify();
      return target;
    }

    if (!this.#idByObject.has(target)) {
      this.#deferredLabels.set(target, clean.length > 0 ? clean : null);
    }
    return target;
  }

  getTargetFunction(nodeId: number): ((...args: never[]) => unknown) | null {
    const record = this.#nodesById.get(nodeId);
    const fn = record?.targetFnRef?.deref();
    if (typeof fn !== "function") return null;
    try {
      const src = Function.prototype.toString.call(fn);
      if (src.includes("[native code]")) {
        return null;
      }
    } catch {
      return null;
    }
    return fn;
  }

  ignoreFrames(...patterns: ReadonlyArray<string>): void {
    this.#ignorePatterns.push(...patterns);
    this.#ignoreMatchers = compileIgnoreMatchers(this.#ignorePatterns);
  }

  configure(settings: Partial<HookSettings>): void {
    this.#settings = {
      writeStacks: settings.writeStacks ?? this.#settings.writeStacks,
      paused: settings.paused ?? this.#settings.paused,
    };
    this.#scheduleNotify();
  }

  clearEvents(): void {
    this.#events.length = 0;
    this.#baseSeq = this.#seq;
    this.#droppedEvents = 0;
    this.#scheduleNotify();
  }

  setValue(nodeId: number, jsonText: string): ActionResult {
    const record = this.#nodesById.get(nodeId);
    if (!record) {
      return { ok: false, error: `Signal #${nodeId} no longer exists` };
    }
    if (record.kind !== "state") {
      return {
        ok: false,
        error: `Node #${nodeId} is a ${record.kind}, not a State signal`,
      };
    }
    const instance = record.ref.deref();
    if (!instance) {
      this.#nodesById.delete(nodeId);
      return { ok: false, error: `Signal #${nodeId} was garbage collected` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      return { ok: false, error: `Invalid JSON: ${formatErrorMessage(err)}` };
    }

    try {
      instance.set(parsed);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatErrorMessage(err) };
    }
  }

  evaluate(nodeId: number): ActionResult {
    const record = this.#nodesById.get(nodeId);
    if (!record) {
      return { ok: false, error: `Signal #${nodeId} no longer exists` };
    }
    if (record.kind !== "computed") {
      return {
        ok: false,
        error: `Node #${nodeId} is a ${record.kind}, not a Computed signal`,
      };
    }
    const instance = record.ref.deref();
    if (!instance) {
      this.#nodesById.delete(nodeId);
      return { ok: false, error: `Signal #${nodeId} was garbage collected` };
    }

    try {
      const value = record.signalApi.subtle.untrack(() => instance.get());
      if (record.runtimeMode === "registered") {
        record.valuePreview = serializePreview(value);
        record.error = null;
        record.unread = false;
        this.#syncNodeSources(record, instance);
      }
      return { ok: true };
    } catch (err) {
      if (record.runtimeMode === "registered") {
        record.error = formatErrorMessage(err);
        record.unread = false;
      }
      return { ok: false, error: formatErrorMessage(err) };
    }
  }

  logToConsole(nodeId: number): ActionResult {
    const record = this.#nodesById.get(nodeId);
    const instance = record?.ref.deref();
    if (!record || !instance) {
      return { ok: false, error: `Signal #${nodeId} is no longer live` };
    }
    (globalThis as Record<string, unknown>).$signal = instance;
    console.info(
      `[tc39-signals-devtools] #${record.id} ${record.kind}${record.label ? ` (${record.label})` : ""}`,
      instance,
    );
    return { ok: true };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  snapshot(sinceSeq?: number): GraphSnapshot {
    if (!this.#inSnapshotRead) {
      this.#inSnapshotRead = true;
      try {
        this.#flushPendingSourceSync();
        for (const entry of this.#registeredRuntimes.values()) {
          this.#crawlRegisteredRuntime(entry);
        }
      } finally {
        this.#inSnapshotRead = false;
      }
    }

    const nodes: SignalNodeSnapshot[] = [];
    const liveIds = new Set<number>();

    for (const [id, record] of this.#nodesById.entries()) {
      if (record.kind === "state") {
        const inst = record.ref.deref();
        if (!inst) {
          this.#nodesById.delete(id);
          continue;
        }
        record.live = safeHasSinks(record.signalApi, inst);
      } else if (record.kind === "computed") {
        const inst = record.ref.deref();
        if (!inst) {
          this.#nodesById.delete(id);
          continue;
        }
        record.live = safeHasSinks(record.signalApi, inst);
      } else {
        const inst = record.ref.deref();
        if (!inst) {
          this.#nodesById.delete(id);
          continue;
        }
        record.live = safeHasSources(record.signalApi, inst);
      }

      liveIds.add(id);
      nodes.push({
        id: record.id,
        kind: record.kind,
        label: record.label,
        ...(record.label === null && record.autoLabel
          ? { autoLabel: record.autoLabel }
          : {}),
        ...(record.ownerLabel ? { ownerLabel: record.ownerLabel } : {}),
        runtime: record.runtime,
        runtimeMode: record.runtimeMode,
        site: record.site,
        value: record.valuePreview,
        error: record.error,
        unread: record.unread,
        live: record.live,
        sets: record.sets,
        runs: record.runs,
        notifies: record.notifies,
        lastRunMs: record.lastRunMs,
        lastChangedSeq: record.lastChangedSeq,
        causes: record.causes,
        ...(record.computeSource
          ? { computeSource: record.computeSource }
          : {}),
        ...(record.computeSignature
          ? { computeSignature: record.computeSignature }
          : {}),
        ...(record.internal ? { internal: true } : {}),
      });
    }

    const edgeKeys = new Set<string>();
    const edges: SignalEdgeSnapshot[] = [];
    for (const record of this.#nodesById.values()) {
      if (!liveIds.has(record.id)) continue;
      for (const sourceId of record.sourceIds) {
        if (!liveIds.has(sourceId)) continue;
        const key = `${sourceId}:${record.id}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ sourceId, sinkId: record.id });
      }
    }

    const events =
      sinceSeq !== undefined
        ? this.#events.filter((event) => event.seq > sinceSeq)
        : [...this.#events];

    return {
      version: 1,
      seq: this.#seq,
      baseSeq: this.#baseSeq,
      droppedEvents: this.#droppedEvents,
      settings: { ...this.#settings },
      runtimes: Array.from(this.#runtimes.values()),
      nodes,
      edges,
      events,
    };
  }

  #createRecord(params: CreateRecordParams): NodeRecord {
    const id = this.#nextNodeId++;
    const deferredLabel = this.#deferredLabels.get(params.instance);
    if (deferredLabel !== undefined) {
      this.#deferredLabels.delete(params.instance);
    }

    if (!this.#runtimes.has(params.runtime)) {
      this.#runtimes.set(params.runtime, {
        name: params.runtime,
        mode: params.runtimeMode,
      });
    }

    const label = params.label ?? deferredLabel ?? null;
    const autoLabel = params.autoLabel ?? null;
    const internal =
      Boolean(params.internal) ||
      detectInternalSignal({
        label,
        site: params.site,
        fnSource: params.computeSource ?? null,
        ...(params.fromInternalPackage !== undefined
          ? { fromInternalPackage: params.fromInternalPackage }
          : {}),
      });

    const common = {
      id,
      label,
      ...(autoLabel ? { autoLabel } : {}),
      ...(params.ownerLabel ? { ownerLabel: params.ownerLabel } : {}),
      ...(params.computeSource ? { computeSource: params.computeSource } : {}),
      ...(params.computeSignature
        ? { computeSignature: params.computeSignature }
        : {}),
      ...(internal ? { internal: true } : {}),
      ...(params.fromInternalPackage ? { fromInternalPackage: true } : {}),
      ...(params.targetFnRef ? { targetFnRef: params.targetFnRef } : {}),
      runtime: params.runtime,
      runtimeMode: params.runtimeMode,
      signalApi: params.signalApi,
      site: params.site,
      valuePreview: params.initialPreview,
      error: null,
      unread: params.unread,
      live: false,
      sets: 0,
      runs: 0,
      notifies: 0,
      lastRunMs: null,
      changeSeq: 0,
      lastChangedSeq: 0,
      causes: [] as ReadonlyArray<number>,
      sourceIds: [] as ReadonlyArray<number>,
      lastSeenSourceSeq: new Map<number, number>(),
      erroredLastRun: false,
    };

    let record: NodeRecord;
    if (params.kind === "state") {
      record = {
        ...common,
        kind: "state",
        ref: new WeakRef(params.instance),
      };
    } else if (params.kind === "computed") {
      record = {
        ...common,
        kind: "computed",
        ref: new WeakRef(params.instance),
      };
    } else {
      record = {
        ...common,
        kind: "watcher",
        ref: new WeakRef(params.instance),
      };
    }

    this.#nodesById.set(id, record);
    this.#idByObject.set(params.instance, id);
    this.#finalizer.register(params.instance, id);
    return record;
  }

  #getRecord(instance: object): NodeRecord | undefined {
    const id = this.#idByObject.get(instance);
    if (id === undefined) return undefined;
    return this.#nodesById.get(id);
  }

  #finalizeComputedRun(
    record: NodeRecord,
    pending: PendingComputedEval,
    value: unknown,
    changed: boolean,
  ): void {
    const durationMs = performance.now() - pending.startMs;
    const preview = serializePreview(value);

    record.unread = false;
    record.runs += 1;
    record.lastRunMs = durationMs;
    record.valuePreview = preview;
    record.error = null;
    record.erroredLastRun = false;
    record.causes = pending.causes;
    if (record.kind === "computed") {
      const inst = record.ref.deref();
      if (inst) {
        record.live = safeHasSinks(record.signalApi, inst);
      }
    }

    const seq = ++this.#seq;
    if (changed) {
      record.changeSeq = seq;
      record.lastChangedSeq = seq;
    }

    this.#pendingSourceSync.add(record.id);
    this.#pushEvent({
      seq,
      timestamp: Date.now(),
      type: "run",
      nodeId: record.id,
      causes: pending.causes,
      first: pending.first,
      changed,
      durationMs,
      to: preview,
    });
    this.#scheduleNotify();
  }

  #markPendingComputedError(
    record: NodeRecord,
    causes: ReadonlyArray<number>,
    startMs: number,
    err: unknown,
  ): void {
    const durationMs = performance.now() - startMs;
    const errorMsg = formatErrorMessage(err);

    record.unread = false;
    record.runs += 1;
    record.lastRunMs = durationMs;
    record.error = errorMsg;
    record.erroredLastRun = true;
    record.causes = causes;
    if (record.kind === "computed") {
      const inst = record.ref.deref();
      if (inst) {
        record.live = safeHasSinks(record.signalApi, inst);
      }
    }

    const seq = ++this.#seq;
    record.changeSeq = seq;
    record.lastChangedSeq = seq;

    this.#pendingSourceSync.add(record.id);
    this.#pushEvent({
      seq,
      timestamp: Date.now(),
      type: "error",
      nodeId: record.id,
      causes,
      durationMs,
      error: errorMsg,
    });
    this.#scheduleNotify();
  }

  #computeCauses(record: NodeRecord): ReadonlyArray<number> {
    const causes: number[] = [];
    for (const sourceId of record.sourceIds) {
      const source = this.#nodesById.get(sourceId);
      if (!source) continue;
      const lastSeen = record.lastSeenSourceSeq.get(sourceId) ?? 0;
      if (source.changeSeq > lastSeen) {
        causes.push(sourceId);
      }
    }
    return causes;
  }

  #flushPendingSourceSync(): void {
    if (this.#pendingSourceSync.size === 0) return;
    const ids = Array.from(this.#pendingSourceSync);
    this.#pendingSourceSync.clear();
    for (const id of ids) {
      const record = this.#nodesById.get(id);
      if (!record) continue;
      if (record.kind === "computed") {
        const inst = record.ref.deref();
        if (inst) this.#syncNodeSources(record, inst);
      } else if (record.kind === "watcher") {
        const inst = record.ref.deref();
        if (inst) this.#syncNodeSources(record, inst);
      }
    }
  }

  #syncNodeSources(
    record: NodeRecord,
    instance: SignalComputedInstance | SignalWatcherInstance,
  ): void {
    let sources: Array<SignalStateInstance | SignalComputedInstance>;
    try {
      sources = record.signalApi.subtle.introspectSources(instance);
    } catch {
      return;
    }

    const nextSourceIds: number[] = [];
    const seenIds = new Set<number>();
    const nextSeenSeq = new Map<number, number>();

    for (const src of sources) {
      let srcRecord = this.#getRecord(src);
      if (!srcRecord) {
        if (isSignalState(record.signalApi, src)) {
          srcRecord = this.#createRecord({
            instance: src,
            kind: "state",
            label: null,
            runtime: record.runtime,
            runtimeMode: "registered",
            signalApi: record.signalApi,
            site: null,
            initialPreview: this.#tryReadStateValue(record.signalApi, src),
            unread: false,
          });
        } else {
          // Never force-evaluate an un-instrumented Computed passively during source sync.
          srcRecord = this.#createRecord({
            instance: src,
            kind: "computed",
            label: null,
            ...buildRegisteredComputedCreateMeta(src),
            runtime: record.runtime,
            runtimeMode: "registered",
            signalApi: record.signalApi,
            site: null,
            initialPreview: null,
            unread: !safeHasSources(record.signalApi, src),
          });
        }
      }
      if (!seenIds.has(srcRecord.id)) {
        seenIds.add(srcRecord.id);
        nextSourceIds.push(srcRecord.id);
      }
      nextSeenSeq.set(srcRecord.id, srcRecord.changeSeq);
    }

    record.sourceIds = nextSourceIds;
    record.lastSeenSourceSeq = nextSeenSeq;
  }

  #refreshLiveFlags(signalApi: SignalNamespace): void {
    for (const record of this.#nodesById.values()) {
      if (record.signalApi !== signalApi) continue;
      if (record.kind === "state") {
        const inst = record.ref.deref();
        if (inst) record.live = safeHasSinks(signalApi, inst);
      } else if (record.kind === "computed") {
        const inst = record.ref.deref();
        if (inst) record.live = safeHasSinks(signalApi, inst);
      } else {
        const inst = record.ref.deref();
        if (inst) record.live = safeHasSources(signalApi, inst);
      }
    }
  }

  #crawlRegisteredRuntime(entry: RegisteredRuntimeEntry): void {
    const queue: Array<SignalWatcherInstance | SignalComputedInstance> = [];
    const visited = new Set<object>();

    for (const watcherRef of entry.watchers) {
      const watcher = watcherRef.deref();
      if (!watcher) {
        entry.watchers.delete(watcherRef);
        continue;
      }
      let wRecord = this.#getRecord(watcher);
      if (!wRecord) {
        wRecord = this.#createRecord({
          instance: watcher,
          kind: "watcher",
          label: null,
          ...buildRegisteredWatcherCreateMeta(watcher),
          runtime: entry.name,
          runtimeMode: "registered",
          signalApi: entry.signalApi,
          site: null,
          initialPreview: null,
          unread: false,
        });
      }
      wRecord.live = safeHasSources(entry.signalApi, watcher);
      queue.push(watcher);
    }

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);

      const currentRecord = this.#getRecord(current);
      if (!currentRecord) continue;

      let sources: Array<SignalStateInstance | SignalComputedInstance> = [];
      try {
        sources = entry.signalApi.subtle.introspectSources(current);
      } catch {
        sources = [];
      }

      const nextSourceIds: number[] = [];
      const seen = new Set<number>();

      for (const src of sources) {
        let srcRecord = this.#getRecord(src);
        const isComp = isSignalComputed(entry.signalApi, src);
        if (!srcRecord) {
          if (isSignalState(entry.signalApi, src)) {
            srcRecord = this.#createRecord({
              instance: src,
              kind: "state",
              label: null,
              runtime: entry.name,
              runtimeMode: "registered",
              signalApi: entry.signalApi,
              site: null,
              initialPreview: null,
              unread: false,
            });
          } else {
            // Do not passively call computed.get(): preserve unread & Watcher.getPending() dirtiness.
            srcRecord = this.#createRecord({
              instance: src,
              kind: "computed",
              label: null,
              ...buildRegisteredComputedCreateMeta(src),
              runtime: entry.name,
              runtimeMode: "registered",
              signalApi: entry.signalApi,
              site: null,
              initialPreview: null,
              unread: !safeHasSources(entry.signalApi, src),
            });
          }
        }

        if (
          srcRecord.runtimeMode === "registered" &&
          srcRecord.kind === "state"
        ) {
          const stateInst = srcRecord.ref.deref();
          if (stateInst) {
            this.#refreshRegisteredStateValue(
              entry.signalApi,
              srcRecord,
              stateInst,
            );
          }
        }

        if (!seen.has(srcRecord.id)) {
          seen.add(srcRecord.id);
          nextSourceIds.push(srcRecord.id);
        }
        if (isComp && !visited.has(src)) {
          queue.push(src);
        }
      }
      currentRecord.sourceIds = nextSourceIds;
    }
  }

  #refreshRegisteredStateValue(
    signalApi: SignalNamespace,
    record: NodeRecord,
    sig: SignalStateInstance,
  ): void {
    try {
      const val = signalApi.subtle.untrack(() => sig.get());
      record.valuePreview = serializePreview(val);
      record.error = null;
      record.unread = false;
    } catch (err) {
      record.error = formatErrorMessage(err);
    }
  }

  #tryReadStateValue(
    signalApi: SignalNamespace,
    sig: SignalStateInstance,
  ): ValuePreview | null {
    try {
      return serializePreview(signalApi.subtle.untrack(() => sig.get()));
    } catch {
      return null;
    }
  }

  #pushEvent(event: SignalEvent): void {
    if (this.#settings.paused) return;
    this.#events.push(event);
    if (this.#events.length > MAX_EVENT_HISTORY) {
      const overflow = this.#events.length - MAX_EVENT_HISTORY;
      this.#events.splice(0, overflow);
      this.#droppedEvents += overflow;
      this.#baseSeq = this.#events[0]?.seq
        ? this.#events[0].seq - 1
        : this.#seq;
    }
  }

  #scheduleNotify(): void {
    if (this.#listeners.size === 0 || this.#notifyScheduled) return;
    this.#notifyScheduled = true;
    queueMicrotask(() => {
      this.#notifyScheduled = false;
      for (const listener of this.#listeners) {
        try {
          listener();
        } catch {
          // Listener failure must never disrupt user page reactivity
        }
      }
    });
  }
}

function safeHasSinks(
  signalApi: SignalNamespace,
  signal: SignalStateInstance | SignalComputedInstance,
): boolean {
  try {
    return signalApi.subtle.hasSinks(signal);
  } catch {
    return false;
  }
}

function safeHasSources(
  signalApi: SignalNamespace,
  sink: SignalComputedInstance | SignalWatcherInstance,
): boolean {
  try {
    return signalApi.subtle.hasSources(sink);
  } catch {
    return false;
  }
}

function isSignalState(
  signalApi: SignalNamespace,
  value: SignalStateInstance | SignalComputedInstance,
): value is SignalStateInstance {
  if (value === null || typeof value !== "object") return false;
  try {
    return signalApi.isState(value);
  } catch {
    return false;
  }
}

function isSignalComputed(
  signalApi: SignalNamespace,
  value: SignalStateInstance | SignalComputedInstance,
): value is SignalComputedInstance {
  if (value === null || typeof value !== "object") return false;
  try {
    return signalApi.isComputed(value);
  } catch {
    return false;
  }
}
