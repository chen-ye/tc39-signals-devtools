import type { SignalKind, SourceLocation } from "../protocol/types.ts";

const MAX_SOURCE_CHARS = 1200;
const MAX_SIGNATURE_CHARS = 120;
const MAX_SUMMARY_CHARS = 60;

const GENERIC_FN_NAMES = new Set([
  "",
  "computation",
  "computed",
  "wrappedComputation",
  "<anonymous>",
]);

export interface ExtractedComputedExpression {
  readonly source: string;
  readonly signature: string;
  readonly summary: string;
  readonly fnName: string | null;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function dedentSource(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  const lines = normalized.split("\n");
  if (lines.length <= 1) return normalized;

  let minIndent = Number.POSITIVE_INFINITY;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    const match = /^[ \t]*/.exec(line);
    const indent = match ? match[0].length : 0;
    if (indent < minIndent) {
      minIndent = indent;
    }
  }

  if (!Number.isFinite(minIndent) || minIndent === 0) {
    return normalized;
  }

  const out: string[] = [lines[0] ?? ""];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    out.push(line.trim().length === 0 ? "" : line.slice(minIndent));
  }
  return out.join("\n").trim();
}

function extractSummary(collapsed: string): string {
  let body = collapsed;

  const arrowMatch =
    /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([\s\S]+)$/.exec(body);
  if (arrowMatch?.[1]) {
    body = arrowMatch[1].trim();
  } else {
    const fnMatch =
      /^(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*(\{[\s\S]*\})$/.exec(
        body,
      );
    if (fnMatch?.[1]) {
      body = fnMatch[1].trim();
    }
  }

  const returnBlockMatch = /^\{\s*return\s+([\s\S]+?);?\s*\}$/.exec(body);
  if (returnBlockMatch?.[1]) {
    body = returnBlockMatch[1].trim();
  } else if (body.startsWith("{") && body.endsWith("}")) {
    const inner = body.slice(1, -1).trim();
    if (inner.length > 0) {
      body = inner;
    }
  }

  if (body.length === 0) {
    body = collapsed;
  }
  return truncateText(body, MAX_SUMMARY_CHARS);
}

export function getFunctionSource(fn: unknown): string | null {
  if (typeof fn !== "function") return null;
  let raw: string;
  try {
    raw = Function.prototype.toString.call(fn);
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("[native code]")) {
    return null;
  }
  return trimmed;
}

export function extractComputedExpression(
  fn: unknown,
): ExtractedComputedExpression | null {
  const raw = getFunctionSource(fn);
  if (!raw || typeof fn !== "function") return null;

  const dedented = dedentSource(raw);
  if (!dedented) return null;

  const collapsed = dedented.replace(/\s+/g, " ").trim();
  const source = truncateText(dedented, MAX_SOURCE_CHARS);
  const signature = truncateText(collapsed, MAX_SIGNATURE_CHARS);
  const summary = extractSummary(collapsed);

  const rawFnName = typeof fn.name === "string" ? fn.name.trim() : "";
  const fnName =
    rawFnName.length > 0 &&
    !GENERIC_FN_NAMES.has(rawFnName) &&
    !rawFnName.startsWith("__SIGNALS_DEVTOOLS__")
      ? rawFnName
      : null;

  return {
    source,
    signature,
    summary,
    fnName,
  };
}

export function extractOwnerLabelFromSite(
  site: SourceLocation | null,
): string | null {
  if (!site?.fn) return null;
  let clean = site.fn.trim();
  if (!clean) return null;

  if (clean.startsWith("new ")) {
    clean = clean.slice(4).trim();
  }
  if (clean.startsWith("Object.")) {
    clean = clean.slice("Object.".length).trim();
  }
  if (clean.endsWith(".<instance_members_initializer>")) {
    clean = clean.slice(0, -".<instance_members_initializer>".length).trim();
  } else if (clean.endsWith(".<static_initializer>")) {
    clean = clean.slice(0, -".<static_initializer>".length).trim();
  }

  if (
    !clean ||
    clean === "<anonymous>" ||
    clean === "<instance_members_initializer>" ||
    clean === "<static_initializer>"
  ) {
    return null;
  }

  return clean;
}

export function inferAutoSignalLabel(params: {
  readonly kind: SignalKind;
  readonly site: SourceLocation | null;
  readonly exprFnName?: string | null;
  readonly exprSummary?: string | null;
}): string | null {
  const exprFnName = params.exprFnName?.trim() ?? "";
  if (
    exprFnName.length > 0 &&
    !GENERIC_FN_NAMES.has(exprFnName) &&
    !exprFnName.startsWith("__SIGNALS_DEVTOOLS__")
  ) {
    return exprFnName;
  }

  if (params.kind === "computed") {
    const summary = params.exprSummary?.trim() ?? "";
    if (summary.length > 0) {
      return summary;
    }
  }

  return extractOwnerLabelFromSite(params.site);
}

export function detectInternalSignal(params: {
  readonly label: string | null;
  readonly site: SourceLocation | null;
  readonly fnSource?: string | null;
  readonly fromInternalPackage?: boolean;
}): boolean {
  if (params.fromInternalPackage) {
    return true;
  }
  if (params.label?.startsWith("__")) {
    return true;
  }
  if (params.site?.fn?.startsWith("__")) {
    return true;
  }
  const owner = extractOwnerLabelFromSite(params.site);
  if (owner?.startsWith("__")) {
    return true;
  }
  if (/@lit-labs[\\/_]signals/i.test(params.site?.file ?? "")) {
    return true;
  }
  if (/__forceUpdate/i.test(params.fnSource ?? "")) {
    return true;
  }
  return false;
}
