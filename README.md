# tc39-signals-devtools

Chrome DevTools extension, instrumentation hook, and Vite/client bridge for inspecting live [TC39 Signals](https://github.com/tc39/proposal-signals) (`signal-polyfill`) reactivity graphs in Chrome DevTools.

## Why an explicit hook + per-origin toggle?

Verified against `signal-polyfill@0.2.3`:

- `signal-polyfill` is an isolated ES module with **zero `globalThis` state**, **no instance registry**, and private ES2022 `#brand` checks (`Signal.isState`, `Signal.isComputed`, `Signal.isWatcher`, `Signal.subtle.introspectSources`).
- `Signal.subtle.introspectSinks` only observes **live** (watched) consumers, and `State.prototype.set` emits no notifications.

Because an extension cannot passively reach inside a closed ESM bundle without breaking feature detection (`'Signal' in globalThis`), `tc39-signals-devtools` combines clean, orthogonal discovery paths:

1. **Pre-existing / native `globalThis.Signal`**: Automatically wrapped at `document_start` in `MAIN` world when already present.
2. **Per-origin `globalThis.Signal` toggle**: Toggle `Inject globalThis.Signal` in the DevTools panel status bar to register `polyfill-provider.js` via `chrome.scripting.registerContentScripts` at `document_start` for that site without polluting unrelated tabs. Works automatically for apps using `const Signal = globalThis.Signal ?? Polyfill`.
3. **Vite plugin (`tc39-signals-devtools/vite`)**: Redirects `import { Signal } from "signal-polyfill"` through `globalThis.__SIGNALS_DEVTOOLS_HOOK__` in Vite dev/build with zero app-code edits.
4. **Client helper (`tc39-signals-devtools`)** or **`globalThis.__SIGNALS_DEVTOOLS_HOOK__.register({ name, Signal, watchers })`**: Explicit instrumentation, labeling (`label(signal, name)`), or read-only traversal of un-instrumented private bundles via `Signal.subtle.introspectSources`.

## Features

- **Interactive SVG Reactivity Graph**: Topological left-to-right layered DAG (`State` → `Computed` → `Watcher`) with distinct node geometry, pointer pan/zoom, cursor-anchored wheel zoom, fit-to-view, and keyboard navigation (`Arrow*`, `Enter`, `Escape`).
- **Causal Re-Run & Upstream/Downstream Highlighting**: Clicking any node highlights transitive upstream sources and downstream sinks, dims unrelated nodes, and marks direct causal invalidation edges (`Why did it re-run?`).
- **Live State Editor & Lazy Evaluation**: Mutate `State` signals directly via JSON in the Inspector, evaluate unread `Computed` signals on demand (without force-evaluating lazy computeds passively), inspect expandable object/Map/Set entries, and expose instances to Console as `$signal`.
- **Causal Event Timeline**: Filterable stream of `create`, `set`, `run`, `error`, and `notify` events with inter-event deltas, duration timings, no-op/unchanged badges, optional `State.set` write-stack capture, and pause/clear controls.
- **Responsive DevTools Themes**: Supports Light, Dark, and Auto (`chrome.devtools.panels.themeName` / `prefers-color-scheme`) plus narrow docked-right, wide docked-bottom, and undocked workstation layouts.

## Project Structure

```text
src/
├── protocol/types.ts         # Shared snapshot, event, and MV3 bridge message contracts
├── hook/                     # Instrumentation engine, value previews, MAIN/ISOLATED bridges
├── client/                   # Client helper (`tc39-signals-devtools`) & Vite plugin (`./vite`)
├── extension/                # MV3 manifest, background SW Port router, devtools registration
├── panel/                    # DevTools panel UI, pure DAG layout, immutable view model, SVG graph
└── demo/                     # Interactive Signal playground with embedded live inspector
scripts/
├── build.ts                  # Builds dist/extension, dist/client, and dist/demo
└── dev-demo.ts               # Serves dist/demo locally
tests/
├── unit/                     # Bun unit tests against real signal-polyfill & Vite
└── e2e/                      # Playwright Chromium tests (MV3 extension, real DevTools tab, panel UI)
```

## Build & Load in Chrome

```bash
bun install
bun run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `dist/extension`.
3. Open any page using signals (or run `bun run dev` and open `http://127.0.0.1:4173`), open Chrome DevTools, and switch to the **Signals** panel.

## Integrating a Bundled App

### Option A: Vite Plugin

```ts
import { defineConfig } from "vite";
import { signalsDevtoolsPlugin } from "tc39-signals-devtools/vite";

export default defineConfig({
  plugins: [signalsDevtoolsPlugin()],
});
```

### Option B: Client Helper

```ts
import { Signal, label } from "tc39-signals-devtools";

const count = label(new Signal.State(0), "count");
const doubled = label(new Signal.Computed(() => count.get() * 2), "doubled");
```

### Option C: Register an Existing Private Runtime

```ts
import { Signal } from "signal-polyfill";

globalThis.__SIGNALS_DEVTOOLS_HOOK__?.register({
  name: "my-app",
  Signal,
  watchers: [myWatcher],
});
```

## Development & Verification

```bash
bun check        # Type-check with Bun
bun run lint     # Type-aware oxlint
bun run fmt:check
bun test         # Unit tests against real signal-polyfill & Vite
bun run test:e2e # Playwright Chromium E2E (MV3 extension + real DevTools panel + UI)
```
