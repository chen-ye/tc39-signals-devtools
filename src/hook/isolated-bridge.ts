import {
  BRIDGE_CHANNEL,
  isValidActionResult,
  isValidGraphSnapshot,
  type PageToPanelMessage,
  type PanelToPageMessage,
} from "../protocol/types.ts";
import { startIsolatedBridge } from "../shared/isolated-bridge.ts";

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

startIsolatedBridge({
  channel: BRIDGE_CHANNEL,
  isValidPageToPanelMessage,
  isValidPanelToPageMessage,
  wakeOnRuntimeMessage: true,
  handlePrerenderingChange: true,
});
