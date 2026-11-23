import { Signal as PolyfillSignal } from "signal-polyfill";
import type {
  RuntimeHandle,
  SignalNamespace,
  SignalWatcherInstance,
  SignalsDevtoolsHook,
} from "../protocol/types.ts";

const GLOBAL_HOOK_KEY = "__SIGNALS_DEVTOOLS_HOOK__";

function isSignalsHook(value: unknown): value is SignalsDevtoolsHook {
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "version") === 1 &&
    typeof Reflect.get(value, "wrap") === "function" &&
    typeof Reflect.get(value, "snapshot") === "function"
  );
}

function readGlobalHook(): SignalsDevtoolsHook | null {
  const candidate: unknown = Reflect.get(globalThis, GLOBAL_HOOK_KEY);
  return isSignalsHook(candidate) ? candidate : null;
}

let cachedClientSignal: SignalNamespace | null = null;

function resolveClientSignal(): SignalNamespace {
  if (cachedClientSignal) return cachedClientSignal;
  const hook = readGlobalHook();
  cachedClientSignal = hook
    ? hook.wrap(PolyfillSignal, "client")
    : PolyfillSignal;
  return cachedClientSignal;
}

export const Signal: SignalNamespace = {
  get State() {
    return resolveClientSignal().State;
  },
  get Computed() {
    return resolveClientSignal().Computed;
  },
  isState(value: unknown) {
    return resolveClientSignal().isState(value);
  },
  isComputed(value: unknown) {
    return resolveClientSignal().isComputed(value);
  },
  isWatcher(value: unknown) {
    return resolveClientSignal().isWatcher(value);
  },
  get subtle() {
    return resolveClientSignal().subtle;
  },
};

export function connectSignals(
  signalApi: SignalNamespace,
  runtimeName = "app",
): SignalNamespace {
  const hook = readGlobalHook();
  return hook ? hook.wrap(signalApi, runtimeName) : signalApi;
}

export function registerWatchers(
  name: string,
  signalApi: SignalNamespace,
  watchers: ReadonlyArray<SignalWatcherInstance>,
): RuntimeHandle {
  const hook = readGlobalHook();
  if (!hook) {
    return {
      addWatcher() {},
      dispose() {},
    };
  }
  return hook.register({ name, Signal: signalApi, watchers });
}

export function label<T extends object>(target: T, name: string): T {
  const hook = readGlobalHook();
  return hook ? hook.label(target, name) : target;
}

export function ignoreFrames(...patterns: ReadonlyArray<string>): void {
  readGlobalHook()?.ignoreFrames(...patterns);
}
