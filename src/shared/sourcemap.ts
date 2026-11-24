const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
}

const VLQ_BASE_SHIFT = 5;
const VLQ_BASE = 1 << VLQ_BASE_SHIFT; // 32
const VLQ_BASE_MASK = VLQ_BASE - 1; // 31
const VLQ_CONTINUATION_BIT = VLQ_BASE; // 32

export interface SourceMapV3 {
  readonly version: 3;
  readonly file?: string | undefined;
  readonly sourceRoot?: string | undefined;
  readonly sources: ReadonlyArray<string | null>;
  readonly sourcesContent?: ReadonlyArray<string | null> | undefined;
  readonly names?: ReadonlyArray<string> | undefined;
  readonly mappings: string;
}

export interface DecodedMappingSegment {
  readonly genCol: number;
  readonly sourceIndex: number;
  readonly origLine: number;
  readonly origCol: number;
  readonly nameIndex: number | null;
}

export interface ParsedSourceMap {
  readonly version: 3;
  readonly file: string | null;
  readonly sourceRoot: string;
  readonly sources: ReadonlyArray<string>;
  readonly names: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<ReadonlyArray<DecodedMappingSegment>>;
}

export interface OriginalPosition {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly name: string | null;
}

export interface SourceMapResolverOptions {
  readonly maxEntries?: number | undefined;
}

export interface SourceMapResolver {
  resolve(
    scriptUrl: string,
    line1: number,
    col1: number,
    fetchText: (url: string) => Promise<string | null>,
  ): Promise<OriginalPosition | null>;
  clear(): void;
  size(): number;
}

function fromVlqSigned(value: number): number {
  const isNegative = (value & 1) === 1;
  const shifted = value >>> 1;
  if (!isNegative) return shifted;
  return shifted === 0 ? 0 : -shifted;
}

export function decodeVlqSegment(segment: string): number[] {
  if (segment.length === 0) return [];
  const values: number[] = [];
  let index = 0;

  while (index < segment.length) {
    let result = 0;
    let shift = 0;
    let continuation = true;

    while (continuation) {
      if (index >= segment.length) {
        throw new Error(`Unexpected end of VLQ segment: "${segment}"`);
      }
      const code = segment.charCodeAt(index++);
      const digit = code < 128 ? (BASE64_LOOKUP[code] ?? -1) : -1;
      if (digit === -1) {
        throw new Error(
          `Invalid base64 VLQ character "${segment[index - 1] ?? ""}" in "${segment}"`,
        );
      }
      continuation = (digit & VLQ_CONTINUATION_BIT) !== 0;
      result += (digit & VLQ_BASE_MASK) << shift;
      shift += VLQ_BASE_SHIFT;
    }

    values.push(fromVlqSigned(result));
  }

  return values;
}

function hasUrlScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

function joinSourceRoot(sourceRoot: string, source: string): string {
  if (!sourceRoot || hasUrlScheme(source) || source.startsWith("/")) {
    return source;
  }
  return sourceRoot.endsWith("/")
    ? `${sourceRoot}${source}`
    : `${sourceRoot}/${source}`;
}

function resolveSourceEntry(
  source: string | null,
  sourceRoot: string,
  baseUrl?: string,
): string {
  if (!source) return "";
  const joined = joinSourceRoot(sourceRoot, source);
  if (hasUrlScheme(joined) || !baseUrl) {
    return joined;
  }
  if (hasUrlScheme(baseUrl)) {
    try {
      return new URL(joined, baseUrl).href;
    } catch {
      return joined;
    }
  }
  return joined;
}

function stripXssiPrefix(raw: string): string {
  if (raw.startsWith(")]}'")) {
    const newline = raw.indexOf("\n");
    return newline === -1 ? "" : raw.slice(newline + 1);
  }
  return raw;
}

export function parseSourceMap(
  raw: string | SourceMapV3,
  baseUrl?: string,
): ParsedSourceMap | null {
  let obj: unknown;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(stripXssiPrefix(raw));
    } catch {
      return null;
    }
  } else {
    obj = raw;
  }

  if (obj === null || typeof obj !== "object") return null;
  if (Reflect.get(obj, "version") !== 3) return null;

  const mappingsRaw = Reflect.get(obj, "mappings");
  const sourcesRaw = Reflect.get(obj, "sources");
  if (typeof mappingsRaw !== "string" || !Array.isArray(sourcesRaw)) {
    return null;
  }

  const fileRaw = Reflect.get(obj, "file");
  const sourceRootRaw = Reflect.get(obj, "sourceRoot");
  const namesRaw = Reflect.get(obj, "names");

  const file = typeof fileRaw === "string" ? fileRaw : null;
  const sourceRoot = typeof sourceRootRaw === "string" ? sourceRootRaw : "";
  const sources = sourcesRaw.map((entry) =>
    resolveSourceEntry(
      typeof entry === "string" ? entry : null,
      sourceRoot,
      baseUrl,
    ),
  );
  const names = Array.isArray(namesRaw)
    ? namesRaw.map((entry) => (typeof entry === "string" ? entry : ""))
    : [];

  const lines: DecodedMappingSegment[][] = [];
  const rawLines = mappingsRaw.split(";");

  let sourceIndex = 0;
  let origLine = 0;
  let origCol = 0;
  let nameIndex = 0;

  try {
    for (const rawLine of rawLines) {
      let genCol = 0;
      const lineSegments: DecodedMappingSegment[] = [];

      if (rawLine.length > 0) {
        const rawSegments = rawLine.split(",");
        for (const seg of rawSegments) {
          if (seg.length === 0) continue;
          const fields = decodeVlqSegment(seg);
          const genColDelta = fields[0];
          if (genColDelta === undefined) continue;
          genCol += genColDelta;

          if (fields.length >= 4) {
            sourceIndex += fields[1] ?? 0;
            origLine += fields[2] ?? 0;
            origCol += fields[3] ?? 0;
            let resolvedNameIndex: number | null = null;
            if (fields.length >= 5) {
              nameIndex += fields[4] ?? 0;
              resolvedNameIndex = nameIndex;
            }
            lineSegments.push({
              genCol,
              sourceIndex,
              origLine,
              origCol,
              nameIndex: resolvedNameIndex,
            });
          } else {
            lineSegments.push({
              genCol,
              sourceIndex: -1,
              origLine: -1,
              origCol: -1,
              nameIndex: null,
            });
          }
        }
      }

      lineSegments.sort((a, b) => a.genCol - b.genCol);
      lines.push(lineSegments);
    }
  } catch {
    return null;
  }

  return {
    version: 3,
    file,
    sourceRoot,
    sources,
    names,
    lines,
  };
}

export function resolveOriginalPosition(
  map: ParsedSourceMap,
  line1: number,
  col1: number,
): OriginalPosition | null {
  if (!Number.isFinite(line1) || line1 < 1) return null;
  const line0 = Math.floor(line1) - 1;
  const col0 = Number.isFinite(col1) && col1 >= 1 ? Math.floor(col1) - 1 : 0;

  const lineSegments = map.lines[line0];
  if (!lineSegments || lineSegments.length === 0) return null;

  let lo = 0;
  let hi = lineSegments.length - 1;
  let matched: DecodedMappingSegment | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const seg = lineSegments[mid];
    if (!seg) break;
    if (seg.genCol <= col0) {
      matched = seg;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (!matched || matched.sourceIndex < 0) return null;
  const source = map.sources[matched.sourceIndex];
  if (!source) return null;

  const name =
    matched.nameIndex !== null ? (map.names[matched.nameIndex] ?? null) : null;

  return {
    source,
    line: matched.origLine + 1,
    column: matched.origCol + 1,
    name,
  };
}

const LINE_SOURCE_MAPPING_PREFIX_RE = /(?:^|[\s;}])\/\/[#@]\s*$/;
const BLOCK_SOURCE_MAPPING_PREFIX_RE = /(?:^|[\s;}])\/\*[#@]\s*$/;
const SOURCE_MAPPING_VALUE_RE = /^([^\s'"]+)/;
const SOURCE_MAPPING_TOKEN = "sourceMappingURL=";

export function extractSourceMappingUrl(sourceText: string): string | null {
  if (!sourceText) return null;
  let searchFrom = sourceText.length;

  while (searchFrom > 0) {
    const tokenIdx = sourceText.lastIndexOf(SOURCE_MAPPING_TOKEN, searchFrom);
    if (tokenIdx === -1) return null;

    const lineStart = sourceText.lastIndexOf("\n", tokenIdx - 1) + 1;
    const prefix = sourceText.slice(lineStart, tokenIdx);
    const isLineDirective = LINE_SOURCE_MAPPING_PREFIX_RE.test(prefix);
    const isBlockDirective =
      !isLineDirective && BLOCK_SOURCE_MAPPING_PREFIX_RE.test(prefix);

    if (isLineDirective || isBlockDirective) {
      const lineEndRaw = sourceText.indexOf(
        "\n",
        tokenIdx + SOURCE_MAPPING_TOKEN.length,
      );
      const lineEnd = lineEndRaw === -1 ? sourceText.length : lineEndRaw;
      let rest = sourceText
        .slice(tokenIdx + SOURCE_MAPPING_TOKEN.length, lineEnd)
        .replace(/\r$/, "")
        .trim();
      if (isBlockDirective) {
        rest = rest.replace(/\s*\*\/\s*$/, "").trim();
      }
      const match = SOURCE_MAPPING_VALUE_RE.exec(rest);
      if (match?.[1]) {
        return match[1];
      }
    }

    searchFrom = tokenIdx - 1;
  }

  return null;
}

export function decodeInlineSourceMapDataUrl(dataUrl: string): string | null {
  if (!dataUrl.startsWith("data:")) return null;
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) return null;

  const header = dataUrl.slice(5, commaIdx).toLowerCase();
  const payload = dataUrl.slice(commaIdx + 1);
  if (!header.includes("application/json")) return null;

  if (header.includes(";base64")) {
    try {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  try {
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

export function resolveSourceMapUrl(
  scriptUrl: string,
  sourceMappingUrl: string,
): string {
  if (sourceMappingUrl.startsWith("data:") || hasUrlScheme(sourceMappingUrl)) {
    return sourceMappingUrl;
  }
  if (hasUrlScheme(scriptUrl)) {
    try {
      return new URL(sourceMappingUrl, scriptUrl).href;
    } catch {
      return sourceMappingUrl;
    }
  }
  const slashIdx = scriptUrl.lastIndexOf("/");
  if (slashIdx === -1) return sourceMappingUrl;
  return `${scriptUrl.slice(0, slashIdx + 1)}${sourceMappingUrl}`;
}

export function createSourceMapResolver(
  options?: SourceMapResolverOptions,
): SourceMapResolver {
  const maxEntries = Math.max(1, options?.maxEntries ?? 50);
  const cache = new Map<string, ParsedSourceMap | null>();

  const getCached = (key: string): ParsedSourceMap | null | undefined => {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key) ?? null;
    // Refresh recency
    cache.delete(key);
    cache.set(key, value);
    return value;
  };

  const setCached = (key: string, value: ParsedSourceMap | null): void => {
    if (cache.has(key)) {
      cache.delete(key);
    } else if (cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    cache.set(key, value);
  };

  return {
    async resolve(scriptUrl, line1, col1, fetchText) {
      let parsed = getCached(scriptUrl);
      if (parsed === undefined) {
        parsed = null;
        try {
          const scriptText = await fetchText(scriptUrl);
          if (scriptText !== null) {
            const mappingUrlRaw = extractSourceMappingUrl(scriptText);
            if (mappingUrlRaw) {
              if (mappingUrlRaw.startsWith("data:")) {
                const json = decodeInlineSourceMapDataUrl(mappingUrlRaw);
                if (json !== null) {
                  parsed = parseSourceMap(json, scriptUrl);
                }
              } else {
                const resolvedMapUrl = resolveSourceMapUrl(
                  scriptUrl,
                  mappingUrlRaw,
                );
                const mapText = await fetchText(resolvedMapUrl);
                if (mapText !== null) {
                  parsed = parseSourceMap(mapText, resolvedMapUrl);
                }
              }
            }
          }
        } catch {
          parsed = null;
        }
        setCached(scriptUrl, parsed);
      }

      if (!parsed) return null;
      return resolveOriginalPosition(parsed, line1, col1);
    },
    clear() {
      cache.clear();
    },
    size() {
      return cache.size;
    },
  };
}
