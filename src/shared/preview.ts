import type { PreviewKind, ValuePreview } from "../protocol/types.ts";

const MAX_INLINE_LEN = 72;
const MAX_STRING_LEN = 44;
const MAX_ENTRIES = 16;

export interface PreviewOptions {
  readonly customFormat?: (
    obj: object,
    depth: number,
    seen: WeakSet<object>,
  ) => string | null | undefined;
  readonly includeErrorStack?: boolean;
}

export function truncateText(
  text: string,
  maxLen = MAX_INLINE_LEN,
): { text: string; truncated: boolean } {
  if (text.length <= maxLen) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxLen - 1)}…`, truncated: true };
}

export function getConstructorName(obj: object): string | null {
  try {
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto === null || typeof proto !== "object") return null;
    const ctor: unknown = Reflect.get(proto, "constructor");
    if (typeof ctor !== "function") return null;
    const name: unknown = Reflect.get(ctor, "name");
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export function safeGetProp(obj: object, key: string): unknown {
  try {
    return Reflect.get(obj, key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Throws: ${msg}]`;
  }
}

export function formatCompact(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  options?: PreviewOptions,
): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "bigint":
      return `${value.toString()}n`;
    case "symbol":
      return value.toString();
    case "string": {
      const escaped = JSON.stringify(value);
      return truncateText(escaped, MAX_STRING_LEN).text;
    }
    case "function": {
      const fnName = (value as { name?: string }).name;
      return fnName ? `ƒ ${fnName}()` : "ƒ ()";
    }
    case "object":
      break;
  }

  const obj = value;
  if (seen.has(obj)) return "[Circular]";

  if (obj instanceof Date) {
    return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  }
  if (obj instanceof RegExp) {
    return obj.toString();
  }
  if (obj instanceof Error) {
    return `${obj.name || "Error"}: ${obj.message}`;
  }
  if (typeof Element !== "undefined" && obj instanceof Element) {
    const tag = obj.tagName.toLowerCase();
    const idPart = obj.id ? `#${obj.id}` : "";
    const classPart =
      typeof obj.className === "string" && obj.className.trim()
        ? `.${obj.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    return `<${tag}${idPart}${classPart}>`;
  }

  if (Array.isArray(obj)) {
    if (depth >= 2) return `Array(${obj.length})`;
    seen.add(obj);
    try {
      const items = obj
        .slice(0, 4)
        .map((item) => formatCompact(item, seen, depth + 1, options));
      const suffix = obj.length > 4 ? `, …+${obj.length - 4}` : "";
      return `[${items.join(", ")}${suffix}]`;
    } finally {
      seen.delete(obj);
    }
  }

  if (obj instanceof Map) return `Map(${obj.size})`;
  if (obj instanceof Set) return `Set(${obj.size})`;

  const customFormatted = options?.customFormat?.(obj, depth, seen);
  if (typeof customFormatted === "string") {
    return customFormatted;
  }

  const ctorName = getConstructorName(obj);
  if (depth >= 2) {
    return ctorName && ctorName !== "Object" ? `${ctorName} {…}` : "{…}";
  }

  seen.add(obj);
  try {
    const keys = Object.keys(obj);
    const parts: string[] = [];
    for (const key of keys.slice(0, 3)) {
      parts.push(
        `${key}: ${formatCompact(safeGetProp(obj, key), seen, depth + 1, options)}`,
      );
    }
    if (keys.length > 3) parts.push(`…+${keys.length - 3}`);
    const prefix = ctorName && ctorName !== "Object" ? `${ctorName} ` : "";
    return `${prefix}{${parts.join(", ")}}`;
  } catch {
    return ctorName ? `${ctorName} [Unreadable]` : "[Unreadable]";
  } finally {
    seen.delete(obj);
  }
}

export function detectKind(value: unknown): PreviewKind {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "function":
      return "function";
    case "object":
      break;
  }
  if (Array.isArray(value)) return "array";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  if (value instanceof Date) return "date";
  if (value instanceof RegExp) return "regexp";
  if (value instanceof Error) return "error";
  if (typeof Element !== "undefined" && value instanceof Element)
    return "element";
  return "object";
}

export function serializePreview(
  value: unknown,
  options?: PreviewOptions,
): ValuePreview {
  try {
    const kind = detectKind(value);
    const seen = new WeakSet();
    const rawText = formatCompact(value, seen, 0, options);
    const truncatedInline =
      typeof value === "string"
        ? JSON.stringify(value).length > MAX_STRING_LEN
        : false;
    const { text, truncated: outerTruncated } = truncateText(rawText);
    const truncated = truncatedInline || outerTruncated;

    if (value === null || typeof value !== "object") {
      return truncated ? { kind, text, truncated: true } : { kind, text };
    }

    const entries: Array<readonly [string, string]> = [];
    let entriesTruncated = truncated;
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        const limit = Math.min(value.length, MAX_ENTRIES);
        for (let i = 0; i < limit; i++) {
          entries.push([String(i), formatCompact(value[i], seen, 1, options)]);
        }
        if (value.length > MAX_ENTRIES) entriesTruncated = true;
      } else if (value instanceof Map) {
        let count = 0;
        for (const [k, v] of value.entries()) {
          if (count >= MAX_ENTRIES) {
            entriesTruncated = true;
            break;
          }
          entries.push([
            formatCompact(k, seen, 1, options),
            formatCompact(v, seen, 1, options),
          ]);
          count++;
        }
      } else if (value instanceof Set) {
        let count = 0;
        for (const item of value.values()) {
          if (count >= MAX_ENTRIES) {
            entriesTruncated = true;
            break;
          }
          entries.push([String(count), formatCompact(item, seen, 1, options)]);
          count++;
        }
      } else if (value instanceof Error) {
        entries.push(["name", value.name]);
        entries.push(["message", value.message]);
        if (options?.includeErrorStack && typeof value.stack === "string") {
          entries.push(["stack", value.stack]);
        }
      } else {
        const keys = Object.keys(value);
        for (const key of keys.slice(0, MAX_ENTRIES)) {
          entries.push([
            key,
            formatCompact(safeGetProp(value, key), seen, 1, options),
          ]);
        }
        if (keys.length > MAX_ENTRIES) entriesTruncated = true;
      }
    } finally {
      seen.delete(value);
    }

    if (entries.length === 0) {
      return entriesTruncated
        ? { kind, text, truncated: true }
        : { kind, text };
    }
    return entriesTruncated
      ? { kind, text, entries, truncated: true }
      : { kind, text, entries };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "unreadable", text: `[Unreadable: ${message}]` };
  }
}

export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name || "Error"}: ${err.message}`;
  }
  return String(err);
}
