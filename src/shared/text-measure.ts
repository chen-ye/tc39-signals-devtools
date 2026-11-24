const DEFAULT_FONT_SPEC =
  '11.5px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const MAX_CACHE_SIZE = 8192;

interface MeasureContextLike {
  font: string;
  measureText(text: string): { readonly width: number };
}

let resolvedContext: MeasureContextLike | null | undefined;
const widthCache = new Map<string, number>();

const PROPORTIONAL_WIDTH_EM: Readonly<Record<string, number>> = {
  " ": 0.27,
  "!": 0.28,
  '"': 0.4,
  "#": 0.58,
  $: 0.56,
  "%": 0.82,
  "&": 0.66,
  "'": 0.23,
  "(": 0.34,
  ")": 0.34,
  "*": 0.44,
  "+": 0.58,
  ",": 0.27,
  "-": 0.36,
  ".": 0.27,
  "/": 0.36,
  ":": 0.28,
  ";": 0.28,
  "<": 0.58,
  "=": 0.58,
  ">": 0.58,
  "?": 0.48,
  "@": 0.92,
  "[": 0.32,
  "\\": 0.36,
  "]": 0.32,
  "^": 0.52,
  _: 0.5,
  "`": 0.34,
  "{": 0.36,
  "|": 0.26,
  "}": 0.36,
  "~": 0.58,
  "·": 0.28,
  "…": 0.88,
  "×": 0.58,
  "→": 0.82,
  "←": 0.82,
  a: 0.54,
  b: 0.58,
  c: 0.5,
  d: 0.58,
  e: 0.54,
  f: 0.34,
  g: 0.58,
  h: 0.57,
  i: 0.25,
  j: 0.26,
  k: 0.52,
  l: 0.25,
  m: 0.86,
  n: 0.57,
  o: 0.56,
  p: 0.58,
  q: 0.58,
  r: 0.36,
  s: 0.48,
  t: 0.35,
  u: 0.57,
  v: 0.51,
  w: 0.76,
  x: 0.51,
  y: 0.51,
  z: 0.48,
  A: 0.68,
  B: 0.67,
  C: 0.7,
  D: 0.73,
  E: 0.61,
  F: 0.57,
  G: 0.74,
  H: 0.73,
  I: 0.28,
  J: 0.49,
  K: 0.66,
  L: 0.56,
  M: 0.85,
  N: 0.73,
  O: 0.76,
  P: 0.64,
  Q: 0.76,
  R: 0.67,
  S: 0.63,
  T: 0.61,
  U: 0.72,
  V: 0.67,
  W: 0.94,
  X: 0.66,
  Y: 0.64,
  Z: 0.63,
};

interface ParsedFontSpec {
  readonly fontSizePx: number;
  readonly isBold: boolean;
  readonly isMonospace: boolean;
}

const FONT_SPEC_CACHE = new Map<string, ParsedFontSpec>();

function parseFontSpec(fontSpec: string): ParsedFontSpec {
  const cached = FONT_SPEC_CACHE.get(fontSpec);
  if (cached) return cached;

  const sizeMatch = /(\d+(?:\.\d+)?)px/i.exec(fontSpec);
  const parsedSize = sizeMatch ? Number(sizeMatch[1]) : 12;
  const fontSizePx =
    Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 12;

  const weightMatch = /(?:^|\s)(bold|bolder|[6-9]\d\d)(?:\s|$)/i.exec(fontSpec);
  const isBold = weightMatch !== null;
  const isMonospace =
    /monospace|ui-monospace|sfmono|menlo|monaco|consolas|courier/i.test(
      fontSpec,
    );

  const parsed: ParsedFontSpec = { fontSizePx, isBold, isMonospace };
  if (FONT_SPEC_CACHE.size < 256) {
    FONT_SPEC_CACHE.set(fontSpec, parsed);
  }
  return parsed;
}

function getMeasureContext(): MeasureContextLike | null {
  if (resolvedContext !== undefined) return resolvedContext;

  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(1, 1);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        resolvedContext = ctx;
        return resolvedContext;
      }
    }
  } catch {
    // Headless environments may construct OffscreenCanvas without 2D support
  }

  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        resolvedContext = ctx;
        return resolvedContext;
      }
    }
  } catch {
    // Ignore when DOM canvas context is unavailable
  }

  resolvedContext = null;
  return null;
}

function estimateFallbackTextPx(text: string, fontSpec: string): number {
  const { fontSizePx, isBold, isMonospace } = parseFontSpec(fontSpec);
  let units = 0;

  if (isMonospace) {
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code > 0xffff) {
        units += 1.2;
      } else if (code >= 0x2e80) {
        units += 1.0;
      } else if (ch === "…") {
        units += 0.72;
      } else {
        units += 0.602;
      }
    }
    return units * fontSizePx;
  }

  for (const ch of text) {
    const known = PROPORTIONAL_WIDTH_EM[ch];
    if (known !== undefined) {
      units += known;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x30 && code <= 0x39) {
      units += 0.56;
    } else if (code > 0xffff) {
      units += 1.15;
    } else if (code >= 0x2e80) {
      units += 1.0;
    } else if (code <= 0x024f) {
      units += 0.56;
    } else {
      units += 0.62;
    }
  }

  const weightFactor = isBold ? 1.04 : 1.0;
  return units * fontSizePx * weightFactor;
}

export function measureTextPx(
  text: string,
  fontSpec: string = DEFAULT_FONT_SPEC,
): number {
  if (text.length === 0) return 0;

  const cacheKey = `${fontSpec}\u0000${text}`;
  const cached = widthCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let width: number;
  const ctx = getMeasureContext();
  if (ctx) {
    try {
      ctx.font = fontSpec;
      const measured = ctx.measureText(text).width;
      width =
        Number.isFinite(measured) && measured >= 0
          ? measured
          : estimateFallbackTextPx(text, fontSpec);
    } catch {
      width = estimateFallbackTextPx(text, fontSpec);
    }
  } else {
    width = estimateFallbackTextPx(text, fontSpec);
  }

  if (widthCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = widthCache.keys().next().value;
    if (oldestKey !== undefined) {
      widthCache.delete(oldestKey);
    }
  }
  widthCache.set(cacheKey, width);
  return width;
}

export function clearTextMeasureCache(): void {
  widthCache.clear();
}
