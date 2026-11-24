import {
  BRIDGE_CHANNEL,
  isValidActionResult,
  isValidGraphSnapshot,
  type ActionResult,
  type BackgroundToPanelMessage,
  type PanelToBackgroundMessage,
  type SourceLocation,
} from "../protocol/types.ts";
import {
  createBasePanelTransport,
  isChromeDevToolsContext,
  type BasePanelTransport,
  type PanelTransportMode,
} from "../shared/panel-transport.ts";
import { openSourceLocation } from "../shared/source-jump.ts";

export { isChromeDevToolsContext };

export interface PanelTransport extends BasePanelTransport<
  BackgroundToPanelMessage,
  PanelToBackgroundMessage
> {
  reloadPage(): void;
  openSource(
    nodeId: number,
    site: SourceLocation | null,
  ): Promise<ActionResult>;
}

function isBackgroundMessage(
  value: unknown,
): value is BackgroundToPanelMessage {
  if (value === null || typeof value !== "object") return false;
  const type = Reflect.get(value, "type");
  switch (type) {
    case "SNAPSHOT":
      return isValidGraphSnapshot(Reflect.get(value, "snapshot"));
    case "ACTION_RESULT":
      return (
        typeof Reflect.get(value, "requestId") === "string" &&
        isValidActionResult(Reflect.get(value, "result"))
      );
    case "PAGE_CONNECTED":
      return (
        Reflect.get(value, "url") === null ||
        typeof Reflect.get(value, "url") === "string"
      );
    case "PAGE_NAVIGATING":
      return typeof Reflect.get(value, "url") === "string";
    case "SITE_TOGGLE_STATE":
      return (
        typeof Reflect.get(value, "originKey") === "string" &&
        typeof Reflect.get(value, "enabled") === "boolean"
      );
    case "PAGE_DISCONNECTED":
    case "PONG":
      return true;
    default:
      return false;
  }
}

function createSignalsPanelTransport(
  mode?: PanelTransportMode,
): PanelTransport {
  const base = createBasePanelTransport<
    BackgroundToPanelMessage,
    PanelToBackgroundMessage
  >({
    channel: BRIDGE_CHANNEL,
    isIncomingMessage: isBackgroundMessage,
    mode,
    pingMessage: { type: "PING" },
    initialBridgeMessage: { type: "START_INSPECTION" },
    createNavigatedMessage: (url) => ({ type: "PAGE_NAVIGATING", url }),
  });

  if (base.mode === "devtools") {
    return {
      ...base,
      reloadPage() {
        chrome.devtools.inspectedWindow.reload({});
      },
      openSource(nodeId, site) {
        const validNodeId = Number.isSafeInteger(nodeId) && nodeId >= 1;
        const evalInspectTargetExpr = validNodeId
          ? `globalThis.__SIGNALS_DEVTOOLS_HOOK__?.getTargetFunction?.(${nodeId})`
          : undefined;
        return openSourceLocation({
          mode: "devtools",
          site,
          evalInspectTargetExpr,
        });
      },
    };
  }

  return {
    ...base,
    reloadPage() {
      base.send({ type: "REQUEST_SNAPSHOT" });
    },
    openSource(_nodeId, site) {
      return openSourceLocation({
        mode: "bridge",
        site,
      });
    },
  };
}

export function createChromeDevtoolsTransport(): PanelTransport {
  return createSignalsPanelTransport("devtools");
}

export function createWindowBridgeTransport(): PanelTransport {
  return createSignalsPanelTransport("bridge");
}

export function createPanelTransport(): PanelTransport {
  return createSignalsPanelTransport();
}
