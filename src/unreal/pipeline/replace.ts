import type { JobReplaceEntry } from "../job/schema.js";

/** Global non-overlapping literal replace on full UTF-8 text (PLAN.md `method: replace`). */
export function replaceAllGlobalLiteral(source: string, pattern: string, value: string): string {
  if (pattern.length === 0) {
    // Empty pattern means "no replace"; keep text unchanged so the file still roundtrips.
    return source;
  }
  return source.split(pattern).join(value);
}

function ensureGlobalRegex(re: RegExp): RegExp {
  if (re.global) {
    return re;
  }
  return new RegExp(re.source, `${re.flags}g`);
}

function regexFromJobEntry(entry: JobReplaceEntry): RegExp {
  if (entry.pattern instanceof RegExp) {
    return ensureGlobalRegex(entry.pattern);
  }
  if (entry.regex === true) {
    if (entry.pattern.length === 0) {
      throw new Error("replace.regex pattern must not be empty");
    }
    const f = entry.flags ?? "g";
    const withG = f.includes("g") ? f : `${f}g`;
    try {
      return new RegExp(entry.pattern, withG);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`replace.regex: invalid RegExp: ${msg}`);
    }
  }
  throw new Error("replace: internal error (expected regex mode)");
}

/**
 * One `replace` row: literal substring replace, or regex replace when `pattern` is `RegExp` or `regex: true`.
 * Replacement is always the string `value` (`$&`, `$1`, … work for regex mode).
 */
export function replaceInString(source: string, entry: JobReplaceEntry): string {
  const { value } = entry;
  if (entry.pattern instanceof RegExp || entry.regex === true) {
    const re =
      entry.pattern instanceof RegExp ? regexFromJobEntry(entry) : regexFromJobEntry(entry);
    return source.replace(re, value);
  }
  return replaceAllGlobalLiteral(source, entry.pattern, value);
}

/** Apply the same job replace to tag values, except `primaryAssetName`. */
export function replaceInTagValuesEntry(
  tags: Record<string, string>,
  entry: JobReplaceEntry,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (k.toLowerCase() === "primaryassetname") {
      out[k] = v;
      continue;
    }
    out[k] = replaceInString(v, entry);
  }
  return out;
}

/** Apply a literal pattern/value to tag values (convenience wrapper). */
export function replaceInTagValues(
  tags: Record<string, string>,
  pattern: string,
  value: string,
): Record<string, string> {
  return replaceInTagValuesEntry(tags, { pattern, value });
}
