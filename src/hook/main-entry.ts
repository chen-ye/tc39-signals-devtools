import {
  BRIDGE_CHANNEL,
  type PageToPanelMessage,
  type PanelToPageMessage,
  type SignalNamespace,
  type WindowBridgeEnvelope,
} from "../protocol/types.ts";
import { getOrInstallGlobalHook } from "./hook.ts";

const hook = getOrInstallGlobalHook();

function isSignalNamespaceLike(value: unknown): value is SignalNamespace {
  if (value === null || typeof value !== "object") return false;
  const subtle: unknown = Reflect.get(value, "subtle");
  return (
    typeof Reflect.get(value, "State") === "function" &&
    typeof Reflect.get(value, "Computed") === "function" &&
    subtle !== null &&
    typeof subtle === "object" &&
    typeof Reflect.get(subtle, "Watcher") === "function" &&
    typeof Reflect.get(subtle, "introspectSources") === "function"
  );
}

// Wrap native or pre-installed globalThis.Signal if present without creating globalThis.Signal where absent.
const existingSignal: unknown = Reflect.get(globalThis, "Signal");
if (isSignalNamespaceLike(existingSignal)) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "Signal");
  if (!desc || desc.writable || desc.configurable) {
    Reflect.set(globalThis, "Signal", hook.wrap(existingSignal, "global"));
  }
}

let inspectionActive = false;
let unsubscribeHook: (() => void) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function postToIsolated(payload: PageToPanelMessage): void {
  const envelope: WindowBridgeEnvelope<PageToPanelMessage> = {
    channel: BRIDGE_CHANNEL,
    direction: "main-to-isolated",
    payload,
  };
  window.postMessage(envelope, "*");
}

function scheduleSnapshotPush(): void {
  if (!inspectionActive || flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!inspectionActive) return;
    postToIsolated({ type: "SNAPSHOT", snapshot: hook.snapshot() });
  }, 24);
}

function startInspection(): void {
  if (!inspectionActive) {
    inspectionActive = true;
    unsubscribeHook = hook.subscribe(() => {
      scheduleSnapshotPush();
    });
  }
  postToIsolated({ type: "SNAPSHOT", snapshot: hook.snapshot() });
}

function stopInspection(): void {
  inspectionActive = false;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  unsubscribeHook?.();
  unsubscribeHook = null;
}

function isIsolatedEnvelope(
  data: unknown,
): data is WindowBridgeEnvelope<PanelToPageMessage> {
  if (data === null || typeof data !== "object") return false;
  if (Reflect.get(data, "channel") !== BRIDGE_CHANNEL) return false;
  if (Reflect.get(data, "direction") !== "isolated-to-main") return false;
  const payload: unknown = Reflect.get(data, "payload");
  return (
    payload !== null &&
    typeof payload === "object" &&
    typeof Reflect.get(payload, "type") === "string"
  );
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (!isIsolatedEnvelope(event.data)) return;

  const msg = event.data.payload;
  switch (msg.type) {
    case "START_INSPECTION":
      startInspection();
      break;
    case "STOP_INSPECTION":
      stopInspection();
      break;
    case "REQUEST_SNAPSHOT":
      postToIsolated({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "SET_STATE_VALUE": {
      const result = hook.setValue(msg.nodeId, msg.jsonText);
      postToIsolated({
        type: "ACTION_RESULT",
        requestId: msg.requestId,
        result,
      });
      postToIsolated({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    }
    case "EVALUATE_COMPUTED": {
      const result = hook.evaluate(msg.nodeId);
      postToIsolated({
        type: "ACTION_RESULT",
        requestId: msg.requestId,
        result,
      });
      postToIsolated({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    }
    case "LOG_NODE":
      hook.logToConsole(msg.nodeId);
      break;
    case "CONFIGURE_HOOK":
      hook.configure(msg.settings);
      postToIsolated({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
    case "CLEAR_EVENTS":
      hook.clearEvents();
      postToIsolated({ type: "SNAPSHOT", snapshot: hook.snapshot() });
      break;
  }
});
