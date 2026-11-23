import type { SignalsDevtoolsHook } from "../protocol/types.ts";
import { SignalsHookEngine } from "./instrument.ts";

export const GLOBAL_HOOK_KEY = "__SIGNALS_DEVTOOLS_HOOK__" as const;

export function createSignalsHook(): SignalsDevtoolsHook {
  const engine = new SignalsHookEngine();

  return {
    version: 1,
    get Signal() {
      return engine.primarySignal;
    },
    wrap(signalApi, runtimeName) {
      return engine.wrap(signalApi, runtimeName);
    },
    register(registration) {
      return engine.register(registration);
    },
    label(target, name) {
      return engine.label(target, name);
    },
    ignoreFrames(...patterns) {
      engine.ignoreFrames(...patterns);
    },
    snapshot(sinceSeq) {
      return engine.snapshot(sinceSeq);
    },
    setValue(nodeId, jsonText) {
      return engine.setValue(nodeId, jsonText);
    },
    evaluate(nodeId) {
      return engine.evaluate(nodeId);
    },
    logToConsole(nodeId) {
      return engine.logToConsole(nodeId);
    },
    configure(settings) {
      engine.configure(settings);
    },
    clearEvents() {
      engine.clearEvents();
    },
    subscribe(listener) {
      return engine.subscribe(listener);
    },
  };
}

function isSignalsHookV1(value: unknown): value is SignalsDevtoolsHook {
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "version") === 1 &&
    typeof Reflect.get(value, "wrap") === "function" &&
    typeof Reflect.get(value, "snapshot") === "function"
  );
}

export function getOrInstallGlobalHook(): SignalsDevtoolsHook {
  const host = globalThis as Record<string, unknown>;
  const existing = host[GLOBAL_HOOK_KEY];
  if (isSignalsHookV1(existing)) {
    return existing;
  }
  const hook = createSignalsHook();
  host[GLOBAL_HOOK_KEY] = hook;
  return hook;
}
