import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  bundleChecked,
  copyPanelAssets,
  createPngCanvas,
  emitClientDeclarations,
} from "./build-shared.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const EXT_DIST = join(DIST, "extension");
const CLIENT_DIST = join(DIST, "client");
const DEMO_DIST = join(DIST, "demo");

function renderIconPng(size: number): Uint8Array {
  const canvas = createPngCanvas(size);

  // Rounded dark-slate badge background
  canvas.fillRoundedRect(0, 0, size, size, size * 0.22, 22, 27, 36);

  // Signal reactivity diamond graph: two left states -> middle computed -> right watcher
  const s1 = { x: size * 0.24, y: size * 0.3 };
  const s2 = { x: size * 0.24, y: size * 0.7 };
  const c = { x: size * 0.52, y: size * 0.5 };
  const w = { x: size * 0.78, y: size * 0.5 };
  const edgeWidth = Math.max(1.2, size * 0.065);

  canvas.drawSegment(s1.x, s1.y, c.x, c.y, edgeWidth, 128, 152, 184);
  canvas.drawSegment(s2.x, s2.y, c.x, c.y, edgeWidth, 128, 152, 184);
  canvas.drawSegment(c.x, c.y, w.x, w.y, edgeWidth, 128, 152, 184);

  const nodeR = Math.max(2, size * 0.115);
  canvas.fillCircle(s1.x, s1.y, nodeR, 88, 166, 255); // State blue
  canvas.fillCircle(s2.x, s2.y, nodeR, 88, 166, 255); // State blue
  canvas.fillCircle(c.x, c.y, nodeR * 1.1, 63, 185, 80); // Computed emerald
  canvas.fillCircle(w.x, w.y, nodeR, 188, 140, 255); // Watcher violet

  return canvas.toPng();
}

async function main(): Promise<void> {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(EXT_DIST, "icons"), { recursive: true });
  mkdirSync(CLIENT_DIST, { recursive: true });
  mkdirSync(DEMO_DIST, { recursive: true });

  // 1. Extension icons
  for (const size of [16, 32, 48, 128]) {
    writeFileSync(
      join(EXT_DIST, "icons", `icon-${size}.png`),
      renderIconPng(size),
    );
  }

  // 2. Extension static manifest & HTML pages
  cpSync(
    join(ROOT, "src/extension/manifest.json"),
    join(EXT_DIST, "manifest.json"),
  );
  cpSync(
    join(ROOT, "src/extension/devtools.html"),
    join(EXT_DIST, "devtools.html"),
  );
  copyPanelAssets(join(ROOT, "src/panel"), EXT_DIST);

  // 3. Extension classic content scripts (IIFE) & ESM worker/devtools/panel scripts
  await Promise.all([
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/hook/main-entry.ts")],
        outdir: EXT_DIST,
        naming: "hook-main.js",
        format: "iife",
        target: "browser",
      },
      "hook-main",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/hook/isolated-bridge.ts")],
        outdir: EXT_DIST,
        naming: "bridge-isolated.js",
        format: "iife",
        target: "browser",
      },
      "bridge-isolated",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/hook/polyfill-provider.ts")],
        outdir: EXT_DIST,
        naming: "polyfill-provider.js",
        format: "iife",
        target: "browser",
      },
      "polyfill-provider",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/extension/background.ts")],
        outdir: EXT_DIST,
        naming: "background.js",
        format: "esm",
        target: "browser",
      },
      "background",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/extension/devtools.ts")],
        outdir: EXT_DIST,
        naming: "devtools.js",
        format: "esm",
        target: "browser",
      },
      "devtools",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/panel/main.ts")],
        outdir: EXT_DIST,
        naming: "panel.js",
        format: "esm",
        target: "browser",
      },
      "panel",
    ),
  ]);

  // 4. Companion client & Vite plugin package builds + .d.ts emission
  await Promise.all([
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/client/index.ts")],
        outdir: CLIENT_DIST,
        naming: "index.js",
        format: "esm",
        target: "browser",
        external: ["signal-polyfill"],
      },
      "client-index",
    ),
    bundleChecked(
      {
        entrypoints: [join(ROOT, "src/client/vite.ts")],
        outdir: CLIENT_DIST,
        naming: "vite.js",
        format: "esm",
        target: "node",
        external: ["vite"],
      },
      "client-vite",
    ),
  ]);

  emitClientDeclarations(ROOT);

  // 5. Demo playground (includes standalone panel copy for embedded preview)
  cpSync(join(ROOT, "src/demo/index.html"), join(DEMO_DIST, "index.html"));
  cpSync(join(ROOT, "src/demo/styles.css"), join(DEMO_DIST, "styles.css"));
  copyPanelAssets(join(ROOT, "src/panel"), DEMO_DIST);
  cpSync(join(EXT_DIST, "panel.js"), join(DEMO_DIST, "panel.js"));

  await bundleChecked(
    {
      entrypoints: [join(ROOT, "src/demo/main.ts")],
      outdir: DEMO_DIST,
      naming: "main.js",
      format: "esm",
      target: "browser",
    },
    "demo",
  );

  console.log("Built dist/extension, dist/client, and dist/demo successfully.");
}

await main();
