import {
  BRIDGE_CHANNEL,
  isValidActionResult,
  isValidGraphSnapshot,
  type IsolatedToBackgroundMessage,
  type PageToPanelMessage,
  type PanelToPageMessage,
  type WindowBridgeEnvelope,
} from "../protocol/types.ts";

let port: chrome.runtime.Port | null = null;
let inspectionActive = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let contextInvalidated = false;

function postToMain(payload: PanelToPageMessage): void {
  const envelope: WindowBridgeEnvelope<PanelToPageMessage> = {
    channel: BRIDGE_CHANNEL,
    direction: "isolated-to-main",
    payload,
  };
  window.postMessage(envelope, "*");
}

function isValidPageToPanelMessage(
  value: unknown,
): value is PageToPanelMessage {
  if (value === null || typeof value !== "object") return false;
  const type = Reflect.get(value, "type");
  if (type === "SNAPSHOT") {
    return isValidGraphSnapshot(Reflect.get(value, "snapshot"));
  }
  if (type === "ACTION_RESULT") {
    return (
      typeof Reflect.get(value, "requestId") === "string" &&
      isValidActionResult(Reflect.get(value, "result"))
    );
  }
  return false;
}

function isValidPanelToPageMessage(
  value: unknown,
): value is PanelToPageMessage {
  if (value === null || typeof value !== "object") return false;
  const type = Reflect.get(value, "type");
  return (
    type === "START_INSPECTION" ||
    type === "STOP_INSPECTION" ||
    type === "REQUEST_SNAPSHOT" ||
    type === "SET_STATE_VALUE" ||
    type === "EVALUATE_COMPUTED" ||
    type === "LOG_NODE" ||
    type === "CONFIGURE_HOOK" ||
    type === "CLEAR_EVENTS"
  );
}

function isMainEnvelope(
  data: unknown,
): data is WindowBridgeEnvelope<PageToPanelMessage> {
  if (data === null || typeof data !== "object") return false;
  if (Reflect.get(data, "channel") !== BRIDGE_CHANNEL) return false;
  if (Reflect.get(data, "direction") !== "main-to-isolated") return false;
  return isValidPageToPanelMessage(Reflect.get(data, "payload"));
}

function safePostToBackground(msg: IsolatedToBackgroundMessage): void {
  if (contextInvalidated) return;
  if (!port) {
    connectPort();
  }
  try {
    port?.postMessage(msg);
  } catch {
    port = null;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (contextInvalidated || reconnectTimer !== null) return;
  const delay = Math.min(3000, 150 * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectPort();
  }, delay);
}

function connectPort(): void {
  if (contextInvalidated) return;
  if (!chrome.runtime?.id) {
    contextInvalidated = true;
    return;
  }

  let nextPort: chrome.runtime.Port;
  try {
    nextPort = chrome.runtime.connect({ name: "content" });
  } catch {
    contextInvalidated = true;
    return;
  }

  port = nextPort;
  reconnectAttempts = 0;

  nextPort.onMessage.addListener((msg: unknown) => {
    if (!isValidPanelToPageMessage(msg)) return;
    if (msg.type === "START_INSPECTION") {
      inspectionActive = true;
    } else if (msg.type === "STOP_INSPECTION") {
      inspectionActive = false;
    }
    postToMain(msg);
  });

  nextPort.onDisconnect.addListener(() => {
    if (port === nextPort) {
      port = null;
    }
    if (!chrome.runtime?.id) {
      contextInvalidated = true;
      return;
    }
    if (inspectionActive) {
      scheduleReconnect();
    }
  });

  safePostToBackground({ type: "BRIDGE_READY", url: window.location.href });
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (!isMainEnvelope(event.data)) return;
  safePostToBackground(event.data.payload);
});

window.addEventListener("pageshow", (event: PageTransitionEvent) => {
  if (event.persisted) {
    connectPort();
    if (inspectionActive) {
      postToMain({ type: "START_INSPECTION" });
    }
  }
});

connectPort();
