import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const EXT_DIST = join(DIST, "extension");
const CLIENT_DIST = join(DIST, "client");
const DEMO_DIST = join(DIST, "demo");

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return chunk;
}

function renderIconPng(size: number): Uint8Array {
  const stride = size * 4 + 1;
  const raw = new Uint8Array(stride * size);

  const setPixel = (
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = y * stride + 1 + x * 4;
    const prevA = (raw[offset + 3] ?? 0) / 255;
    const nextA = a / 255;
    const outA = nextA + prevA * (1 - nextA);
    if (outA <= 0) return;
    raw[offset] = Math.round(
      (r * nextA + (raw[offset] ?? 0) * prevA * (1 - nextA)) / outA,
    );
    raw[offset + 1] = Math.round(
      (g * nextA + (raw[offset + 1] ?? 0) * prevA * (1 - nextA)) / outA,
    );
    raw[offset + 2] = Math.round(
      (b * nextA + (raw[offset + 2] ?? 0) * prevA * (1 - nextA)) / outA,
    );
    raw[offset + 3] = Math.round(outA * 255);
  };

  const fillCircle = (
    cx: number,
    cy: number,
    radius: number,
    r: number,
    g: number,
    b: number,
  ) => {
    const minX = Math.floor(cx - radius - 1);
    const maxX = Math.ceil(cx + radius + 1);
    const minY = Math.floor(cy - radius - 1);
    const maxY = Math.ceil(cy + radius + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const alpha = Math.max(0, Math.min(1, radius + 0.5 - dist));
        if (alpha > 0) setPixel(x, y, r, g, b, Math.round(alpha * 255));
      }
    }
  };

  const drawSegment = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    thickness: number,
    r: number,
    g: number,
    b: number,
  ) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    const minX = Math.floor(Math.min(x1, x2) - thickness - 1);
    const maxX = Math.ceil(Math.max(x1, x2) + thickness + 1);
    const minY = Math.floor(Math.min(y1, y2) - thickness - 1);
    const maxY = Math.ceil(Math.max(y1, y2) + thickness + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = Math.max(
          0,
          Math.min(1, ((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / len2),
        );
        const px = x1 + t * dx;
        const py = y1 + t * dy;
        const dist = Math.hypot(x + 0.5 - px, y + 0.5 - py);
        const alpha = Math.max(0, Math.min(1, thickness * 0.5 + 0.5 - dist));
        if (alpha > 0) setPixel(x, y, r, g, b, Math.round(alpha * 255));
      }
    }
  };

  // Rounded dark-slate badge background
  const radius = size * 0.22;
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // PNG filter type 0
    for (let x = 0; x < size; x++) {
      const dx = Math.max(
        0,
        Math.abs(x + 0.5 - size / 2) - (size / 2 - radius),
      );
      const dy = Math.max(
        0,
        Math.abs(y + 0.5 - size / 2) - (size / 2 - radius),
      );
      const dist = Math.hypot(dx, dy);
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - dist));
      if (alpha > 0) {
        setPixel(x, y, 22, 27, 36, Math.round(alpha * 255));
      }
    }
  }

  // Signal reactivity diamond graph: two left states -> middle computed -> right watcher
  const s1 = { x: size * 0.24, y: size * 0.3 };
  const s2 = { x: size * 0.24, y: size * 0.7 };
  const c = { x: size * 0.52, y: size * 0.5 };
  const w = { x: size * 0.78, y: size * 0.5 };
  const edgeWidth = Math.max(1.2, size * 0.065);

  drawSegment(s1.x, s1.y, c.x, c.y, edgeWidth, 128, 152, 184);
  drawSegment(s2.x, s2.y, c.x, c.y, edgeWidth, 128, 152, 184);
  drawSegment(c.x, c.y, w.x, w.y, edgeWidth, 128, 152, 184);

  const nodeR = Math.max(2, size * 0.115);
  fillCircle(s1.x, s1.y, nodeR, 88, 166, 255); // State blue
  fillCircle(s2.x, s2.y, nodeR, 88, 166, 255); // State blue
  fillCircle(c.x, c.y, nodeR * 1.1, 63, 185, 80); // Computed emerald
  fillCircle(w.x, w.y, nodeR, 188, 140, 255); // Watcher violet

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, size, false);
  ihdrView.setUint32(4, size, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = deflateSync(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makePngChunk("IHDR", ihdr);
  const idatChunk = makePngChunk("IDAT", compressed);
  const iendChunk = makePngChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(
    sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let pos = 0;
  for (const part of [sig, ihdrChunk, idatChunk, iendChunk]) {
    png.set(part, pos);
    pos += part.length;
  }
  return png;
}

async function bundleChecked(
  options: Parameters<typeof Bun.build>[0],
  label: string,
): Promise<void> {
  const result = await Bun.build(options);
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Bun.build failed for ${label}:\n${details}`);
  }
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
  cpSync(join(ROOT, "src/panel/panel.html"), join(EXT_DIST, "panel.html"));
  cpSync(join(ROOT, "src/panel/panel.css"), join(EXT_DIST, "panel.css"));

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

  const tscProc = Bun.spawnSync(
    ["bunx", "tsc", "-p", join(ROOT, "tsconfig.client.json")],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (tscProc.exitCode !== 0) {
    throw new Error(
      `tsc declaration emit failed:\n${tscProc.stdout.toString()}\n${tscProc.stderr.toString()}`,
    );
  }

  // 5. Demo playground (includes standalone panel copy for embedded preview)
  cpSync(join(ROOT, "src/demo/index.html"), join(DEMO_DIST, "index.html"));
  cpSync(join(ROOT, "src/demo/styles.css"), join(DEMO_DIST, "styles.css"));
  cpSync(join(ROOT, "src/panel/panel.html"), join(DEMO_DIST, "panel.html"));
  cpSync(join(ROOT, "src/panel/panel.css"), join(DEMO_DIST, "panel.css"));
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
