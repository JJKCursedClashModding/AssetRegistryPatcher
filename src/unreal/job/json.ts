/**
 * Job files use strict JSON only (no JSON5, comments, or trailing commas).
 */

export function parseStrictJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${label} must be strict JSON (no comments or trailing commas): ${msg}`);
  }
}
