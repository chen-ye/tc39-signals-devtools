import { Signal as RawSignal } from "signal-polyfill";
import { getOrInstallGlobalHook } from "../../src/hook/hook.ts";

const hook = getOrInstallGlobalHook();
const Signal = hook.wrap(RawSignal, "demo");

class MiniGridLayout {
  readonly rows = new Signal.State([1, 2, 3]);
  readonly visibleRows = new Signal.Computed(() =>
    this.rows.get().filter((r) => r > 1),
  );
  readonly forceUpdateState = new Signal.State(0, {
    name: "__forceUpdateSignal",
  });
}

const grid = new MiniGridLayout();
const watcher = new Signal.subtle.Watcher(() => {});
watcher.watch(grid.visibleRows, grid.forceUpdateState);
void grid.visibleRows.get();

Reflect.set(window, "__SIGNALS_FIXTURE__", { hook, grid, watcher });
