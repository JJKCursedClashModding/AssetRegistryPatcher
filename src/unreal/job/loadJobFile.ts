import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { parseStrictJson } from "./json.js";

/**
 * Load a job from `.json` (strict parse) or `.ts` / `.mts` (default export must be the job object).
 */
export function loadJobFile(jobPath: string): unknown {
  const ext = path.extname(jobPath).toLowerCase();
  const abs = path.resolve(jobPath);
  if (ext === ".json") {
    return parseStrictJson(readFileSync(abs, "utf8"), "Job file");
  }
  if (ext === ".ts" || ext === ".mts") {
    // Create jiti lazily using the job file's own URL — avoids module-level meta
    // URL issues in bundled or Node.js SEA contexts.
    const jiti = createJiti(pathToFileURL(abs).href, { interopDefault: true });
    const mod = jiti(abs) as Record<string, unknown>;
    const raw = (mod.default ?? mod) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Job module must default-export a job object: ${jobPath}`);
    }
    return raw;
  }
  throw new Error(`Unsupported job file extension ${ext} (use .json, .ts, or .mts): ${jobPath}`);
}
