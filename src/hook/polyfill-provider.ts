import { Signal } from "signal-polyfill";
import { getOrInstallGlobalHook } from "./hook.ts";

// Dynamically injected at document_start ONLY on sites where the user enabled
// "Provide globalThis.Signal" in the DevTools panel.
const hook = getOrInstallGlobalHook();
if (Reflect.get(globalThis, "Signal") === undefined) {
  Reflect.set(globalThis, "Signal", hook.wrap(Signal, "polyfill"));
}
