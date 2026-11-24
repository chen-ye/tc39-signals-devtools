import { cpSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function makePngChunk(type: string, data: Uint8Array): Uint8Array {
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

export function encodeRgbaPng(
  size: number,
  rgbaOrScanlines: Uint8Array,
): Uint8Array {
  const stride = size * 4 + 1;
  const expectedScanlineLen = stride * size;
  const expectedFlatLen = size * size * 4;
  let scanlines: Uint8Array;

  if (rgbaOrScanlines.length === expectedScanlineLen) {
    scanlines = rgbaOrScanlines;
  } else if (rgbaOrScanlines.length === expectedFlatLen) {
    scanlines = new Uint8Array(expectedScanlineLen);
    for (let y = 0; y < size; y++) {
      scanlines[y * stride] = 0;
      const srcStart = y * size * 4;
      scanlines.set(
        rgbaOrScanlines.subarray(srcStart, srcStart + size * 4),
        y * stride + 1,
      );
    }
  } else {
    throw new Error(
      `Invalid RGBA buffer length ${rgbaOrScanlines.length} for ${size}x${size} PNG`,
    );
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, size, false);
  ihdrView.setUint32(4, size, false);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const compressed = deflateSync(scanlines);
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

export interface PngCanvas {
  readonly size: number;
  readonly stride: number;
  readonly raw: Uint8Array;
  setPixel(
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void;
  fillCircle(
    cx: number,
    cy: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    a?: number,
  ): void;
  drawSegment(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    thickness: number,
    r: number,
    g: number,
    b: number,
    a?: number,
  ): void;
  fillRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    a?: number,
  ): void;
  toPng(): Uint8Array;
}

export function createPngCanvas(size: number): PngCanvas {
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
    a = 255,
  ) => {
    const minX = Math.floor(cx - radius - 1);
    const maxX = Math.ceil(cx + radius + 1);
    const minY = Math.floor(cy - radius - 1);
    const maxY = Math.ceil(cy + radius + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const alpha = Math.max(0, Math.min(1, radius + 0.5 - dist));
        if (alpha > 0) setPixel(x, y, r, g, b, Math.round(alpha * a));
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
    a = 255,
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
        if (alpha > 0) setPixel(x, y, r, g, b, Math.round(alpha * a));
      }
    }
  };

  const fillRoundedRect = (
    rx: number,
    ry: number,
    width: number,
    height: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    a = 255,
  ) => {
    const cx = rx + width / 2;
    const cy = ry + height / 2;
    const halfW = width / 2 - radius;
    const halfH = height / 2 - radius;
    const minX = Math.floor(rx - 1);
    const maxX = Math.ceil(rx + width + 1);
    const minY = Math.floor(ry - 1);
    const maxY = Math.ceil(ry + height + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = Math.max(0, Math.abs(x + 0.5 - cx) - halfW);
        const dy = Math.max(0, Math.abs(y + 0.5 - cy) - halfH);
        const dist = Math.hypot(dx, dy);
        const alpha = Math.max(0, Math.min(1, radius + 0.5 - dist));
        if (alpha > 0) {
          setPixel(x, y, r, g, b, Math.round(alpha * a));
        }
      }
    }
  };

  return {
    size,
    stride,
    raw,
    setPixel,
    fillCircle,
    drawSegment,
    fillRoundedRect,
    toPng() {
      return encodeRgbaPng(size, raw);
    },
  };
}

export async function bundleChecked(
  options: Parameters<typeof Bun.build>[0],
  label: string,
): Promise<void> {
  const result = await Bun.build(options);
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Bun.build failed for ${label}:\n${details}`);
  }
}

export function emitClientDeclarations(
  rootDir: string,
  tsconfigPath = join(rootDir, "tsconfig.client.json"),
): void {
  const tscProc = Bun.spawnSync(["bunx", "tsc", "-p", tsconfigPath], {
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tscProc.exitCode !== 0) {
    throw new Error(
      `tsc declaration emit failed:\n${tscProc.stdout.toString()}\n${tscProc.stderr.toString()}`,
    );
  }
}

export function copyPanelAssets(panelSrcDir: string, outDir: string): void {
  for (const file of ["panel.html", "panel.css", "panel-base.css"]) {
    cpSync(join(panelSrcDir, file), join(outDir, file));
  }
}
