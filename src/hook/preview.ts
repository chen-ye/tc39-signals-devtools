import type { PreviewKind, ValuePreview } from "../protocol/types.ts";

const MAX_INLINE_LEN = 72;
const MAX_ENTRIES = 16;

function truncateText(
  text: string,
  maxLen = MAX_INLINE_LEN,
): { text: string; truncated: boolean } {
  if (text.length <= maxLen) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxLen - 1)}…`, truncated: true };
}

function formatCompact(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
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
      return truncateText(escaped, 44).text;
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
    const className =
      typeof obj.className === "string" && obj.className.trim()
        ? `.${obj.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    return `<${tag}${idPart}${className}>`;
  }

  if (Array.isArray(obj)) {
    if (depth >= 2) return `Array(${obj.length})`;
    seen.add(obj);
    try {
      const items = obj
        .slice(0, 4)
        .map((item) => formatCompact(item, seen, depth + 1));
      const suffix = obj.length > 4 ? `, …+${obj.length - 4}` : "";
      return `[${items.join(", ")}${suffix}]`;
    } finally {
      seen.delete(obj);
    }
  }

  if (obj instanceof Map) {
    return `Map(${obj.size})`;
  }
  if (obj instanceof Set) {
    return `Set(${obj.size})`;
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
        `${key}: ${formatCompact(safeGetProp(obj, key), seen, depth + 1)}`,
      );
    }
    if (keys.length > 3) {
      parts.push(`…+${keys.length - 3}`);
    }
    const prefix = ctorName && ctorName !== "Object" ? `${ctorName} ` : "";
    return `${prefix}{${parts.join(", ")}}`;
  } catch {
    return ctorName ? `${ctorName} [Unreadable]` : "[Unreadable]";
  } finally {
    seen.delete(obj);
  }
}

function getConstructorName(obj: object): string | null {
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

function safeGetProp(obj: object, key: string): unknown {
  try {
    return Reflect.get(obj, key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Throws: ${msg}]`;
  }
}

function detectKind(value: unknown): PreviewKind {
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

export function serializePreview(value: unknown): ValuePreview {
  try {
    const kind = detectKind(value);
    const seen = new WeakSet();
    const rawText = formatCompact(value, seen, 0);
    const truncatedInline =
      typeof value === "string" ? JSON.stringify(value).length > 44 : false;
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
          entries.push([String(i), formatCompact(value[i], seen, 1)]);
        }
        if (value.length > MAX_ENTRIES) entriesTruncated = true;
      } else if (value instanceof Map) {
        let count = 0;
        for (const [k, v] of value.entries()) {
          if (count >= MAX_ENTRIES) {
            entriesTruncated = true;
            break;
          }
          entries.push([formatCompact(k, seen, 1), formatCompact(v, seen, 1)]);
          count++;
        }
      } else if (value instanceof Set) {
        let count = 0;
        for (const item of value.values()) {
          if (count >= MAX_ENTRIES) {
            entriesTruncated = true;
            break;
          }
          entries.push([String(count), formatCompact(item, seen, 1)]);
          count++;
        }
      } else if (value instanceof Error) {
        entries.push(["name", value.name]);
        entries.push(["message", value.message]);
        if (value.stack) {
          entries.push([
            "stack",
            truncateText(value.stack.split("\n")[0] ?? "", 64).text,
          ]);
        }
      } else {
        const keys = Object.keys(value);
        for (const key of keys.slice(0, MAX_ENTRIES)) {
          entries.push([key, formatCompact(safeGetProp(value, key), seen, 1)]);
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
