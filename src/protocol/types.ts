export type SignalKind = "state" | "computed" | "watcher";
export type RuntimeMode = "instrumented" | "registered";

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly fn: string | null;
}

export type PreviewKind =
  | "undefined"
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "bigint"
  | "symbol"
  | "function"
  | "array"
  | "object"
  | "map"
  | "set"
  | "date"
  | "regexp"
  | "error"
  | "element"
  | "circular"
  | "unreadable";

export interface ValuePreview {
  readonly kind: PreviewKind;
  readonly text: string;
  readonly entries?: ReadonlyArray<readonly [string, string]>;
  readonly truncated?: boolean;
}

export interface SignalNodeSnapshot {
  readonly id: number;
  readonly kind: SignalKind;
  readonly label: string | null;
  readonly autoLabel?: string | null;
  readonly ownerLabel?: string | null;
  readonly runtime: string;
  readonly runtimeMode: RuntimeMode;
  readonly site: SourceLocation | null;
  readonly value: ValuePreview | null;
  readonly error: string | null;
  readonly unread: boolean;
  readonly live: boolean;
  readonly sets: number;
  readonly runs: number;
  readonly notifies: number;
  readonly lastRunMs: number | null;
  readonly lastChangedSeq: number;
  readonly causes: ReadonlyArray<number>;
  readonly computeSource?: string | null;
  readonly computeSignature?: string | null;
  readonly internal?: boolean;
}

export interface SignalEdgeSnapshot {
  readonly sourceId: number;
  readonly sinkId: number;
}

export type SignalEvent =
  | {
      readonly seq: number;
      readonly timestamp: number;
      readonly type: "create";
      readonly nodeId: number;
      readonly kind: SignalKind;
      readonly label: string | null;
    }
  | {
      readonly seq: number;
      readonly timestamp: number;
      readonly type: "set";
      readonly nodeId: number;
      readonly from: ValuePreview;
      readonly to: ValuePreview;
      readonly changed: boolean;
      readonly site: SourceLocation | null;
    }
  | {
      readonly seq: number;
      readonly timestamp: number;
      readonly type: "run";
      readonly nodeId: number;
      readonly causes: ReadonlyArray<number>;
      readonly first: boolean;
      readonly changed: boolean;
      readonly durationMs: number;
      readonly to: ValuePreview;
    }
  | {
      readonly seq: number;
      readonly timestamp: number;
      readonly type: "error";
      readonly nodeId: number;
      readonly causes: ReadonlyArray<number>;
      readonly durationMs: number;
      readonly error: string;
    }
  | {
      readonly seq: number;
      readonly timestamp: number;
      readonly type: "notify";
      readonly nodeId: number;
      readonly pendingIds: ReadonlyArray<number>;
    };

export interface HookSettings {
  readonly writeStacks: boolean;
  readonly paused: boolean;
}

export interface RuntimeInfo {
  readonly name: string;
  readonly mode: RuntimeMode;
}

export interface GraphSnapshot {
  readonly version: 1;
  readonly seq: number;
  readonly baseSeq: number;
  readonly droppedEvents: number;
  readonly settings: HookSettings;
  readonly runtimes: ReadonlyArray<RuntimeInfo>;
  readonly nodes: ReadonlyArray<SignalNodeSnapshot>;
  readonly edges: ReadonlyArray<SignalEdgeSnapshot>;
  readonly events: ReadonlyArray<SignalEvent>;
}

export type ActionResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface SignalOptions<T> {
  equals?: (prev: T, next: T) => boolean;
  name?: string;
  [key: symbol]: (() => void) | undefined;
}

export interface SignalStateInstance<T = unknown> {
  get(): T;
  set(newValue: T): void;
}

export interface SignalComputedInstance<T = unknown> {
  get(): T;
}

export interface SignalWatcherInstance {
  watch(...signals: Array<SignalStateInstance | SignalComputedInstance>): void;
  unwatch(
    ...signals: Array<SignalStateInstance | SignalComputedInstance>
  ): void;
  getPending(): Array<SignalComputedInstance>;
}

export interface SignalNamespace {
  State: new <T>(
    initialValue: T,
    options?: SignalOptions<T>,
  ) => SignalStateInstance<T>;
  Computed: new <T>(
    computation: () => T,
    options?: SignalOptions<T>,
  ) => SignalComputedInstance<T>;
  isState(value: unknown): boolean;
  isComputed(value: unknown): boolean;
  isWatcher(value: unknown): boolean;
  subtle: {
    untrack<T>(cb: () => T): T;
    currentComputed(): SignalComputedInstance | undefined;
    introspectSources(
      sink: SignalComputedInstance | SignalWatcherInstance,
    ): Array<SignalStateInstance | SignalComputedInstance>;
    introspectSinks(
      signal: SignalStateInstance | SignalComputedInstance,
    ): Array<SignalComputedInstance | SignalWatcherInstance>;
    hasSinks(signal: SignalStateInstance | SignalComputedInstance): boolean;
    hasSources(sink: SignalComputedInstance | SignalWatcherInstance): boolean;
    Watcher: new (notify: () => void) => SignalWatcherInstance;
    readonly watched: symbol;
    readonly unwatched: symbol;
  };
}

export interface RuntimeRegistration {
  readonly name: string;
  readonly Signal: SignalNamespace;
  readonly watchers?: ReadonlyArray<SignalWatcherInstance>;
}

export interface RuntimeHandle {
  addWatcher(watcher: SignalWatcherInstance): void;
  dispose(): void;
}

export interface SignalsDevtoolsHook {
  readonly version: 1;
  readonly Signal: SignalNamespace | null;
  wrap(signalApi: SignalNamespace, runtimeName?: string): SignalNamespace;
  register(registration: RuntimeRegistration): RuntimeHandle;
  label<T extends object>(target: T, name: string): T;
  ignoreFrames(...patterns: ReadonlyArray<string>): void;
  snapshot(sinceSeq?: number): GraphSnapshot;
  setValue(nodeId: number, jsonText: string): ActionResult;
  evaluate(nodeId: number): ActionResult;
  logToConsole(nodeId: number): ActionResult;
  configure(settings: Partial<HookSettings>): void;
  clearEvents(): void;
  subscribe(listener: () => void): () => void;
  getTargetFunction?(nodeId: number): ((...args: never[]) => unknown) | null;
}

export type PanelToPageMessage =
  | { readonly type: "START_INSPECTION" }
  | { readonly type: "STOP_INSPECTION" }
  | { readonly type: "REQUEST_SNAPSHOT" }
  | {
      readonly type: "SET_STATE_VALUE";
      readonly nodeId: number;
      readonly jsonText: string;
      readonly requestId: string;
    }
  | {
      readonly type: "EVALUATE_COMPUTED";
      readonly nodeId: number;
      readonly requestId: string;
    }
  | { readonly type: "LOG_NODE"; readonly nodeId: number }
  | {
      readonly type: "CONFIGURE_HOOK";
      readonly settings: Partial<HookSettings>;
    }
  | { readonly type: "CLEAR_EVENTS" };

export type PageToPanelMessage =
  | { readonly type: "SNAPSHOT"; readonly snapshot: GraphSnapshot }
  | {
      readonly type: "ACTION_RESULT";
      readonly requestId: string;
      readonly result: ActionResult;
    };

export type PanelToBackgroundMessage =
  | PanelToPageMessage
  | { readonly type: "GET_SITE_TOGGLE"; readonly originKey: string }
  | {
      readonly type: "SET_SITE_TOGGLE";
      readonly originKey: string;
      readonly enabled: boolean;
    }
  | { readonly type: "PING" };

export type BackgroundToPanelMessage =
  | PageToPanelMessage
  | { readonly type: "PAGE_CONNECTED"; readonly url: string | null }
  | { readonly type: "PAGE_NAVIGATING"; readonly url: string }
  | { readonly type: "PAGE_DISCONNECTED" }
  | {
      readonly type: "SITE_TOGGLE_STATE";
      readonly originKey: string;
      readonly enabled: boolean;
    }
  | { readonly type: "PONG" };

export type IsolatedToBackgroundMessage =
  PageToPanelMessage | { readonly type: "BRIDGE_READY"; readonly url: string };

export const BRIDGE_CHANNEL = "tc39-signals-devtools" as const;

export interface WindowBridgeEnvelope<T> {
  readonly channel: typeof BRIDGE_CHANNEL;
  readonly direction: "main-to-isolated" | "isolated-to-main";
  readonly payload: T;
}

export function normalizeOriginKey(
  rawUrl: string | null | undefined,
): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.protocol}//${parsed.hostname}`;
    }
    if (parsed.protocol === "file:") {
      return "file://";
    }
    return null;
  } catch {
    return null;
  }
}

export function toMatchPattern(originKey: string): string | null {
  if (originKey === "file://") {
    return "file:///*";
  }
  if (originKey.startsWith("http://") || originKey.startsWith("https://")) {
    const host = originKey.replace(/^https?:\/\//, "");
    // Chrome match patterns reject ports and bracketed IPv6 host literals.
    if (
      !host ||
      host.includes("[") ||
      host.includes("]") ||
      host.includes(":")
    ) {
      return null;
    }
    return `${originKey}/*`;
  }
  return null;
}

export function isValidGraphSnapshot(value: unknown): value is GraphSnapshot {
  if (value === null || typeof value !== "object") return false;
  if (Reflect.get(value, "version") !== 1) return false;
  if (typeof Reflect.get(value, "seq") !== "number") return false;
  const settings: unknown = Reflect.get(value, "settings");
  if (settings === null || typeof settings !== "object") return false;
  if (typeof Reflect.get(settings, "paused") !== "boolean") return false;
  if (typeof Reflect.get(settings, "writeStacks") !== "boolean") return false;
  return (
    Array.isArray(Reflect.get(value, "runtimes")) &&
    Array.isArray(Reflect.get(value, "nodes")) &&
    Array.isArray(Reflect.get(value, "edges")) &&
    Array.isArray(Reflect.get(value, "events"))
  );
}

export function isValidActionResult(value: unknown): value is ActionResult {
  if (value === null || typeof value !== "object") return false;
  const ok = Reflect.get(value, "ok");
  if (ok === true) return true;
  return ok === false && typeof Reflect.get(value, "error") === "string";
}
