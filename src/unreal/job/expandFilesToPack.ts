import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveUnderRoot, toPosixAssetPath } from "../path/safePaths.js";
import type { FileToPackItem, JobRegistryBase } from "./schema.js";

function walkUassets(absDir: string, out: string[]): void {
  for (const name of readdirSync(absDir)) {
    const p = path.join(absDir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walkUassets(p, out);
    } else if (st.isFile() && name.toLowerCase().endsWith(".uasset")) {
      out.push(p);
    }
  }
}

export interface ExpandedPackFile {
  posix: string;
  /** Same `base` for every file expanded from one `filesToPack` object entry (including directory walks). */
  base?: JobRegistryBase;
}

function packPathAndBase(entry: FileToPackItem): { rawPath: string; base?: JobRegistryBase } {
  if (typeof entry === "string") {
    return { rawPath: entry };
  }
  return { rawPath: entry.path, base: entry.base };
}

/**
 * Resolve `filesToPack` entries to `.uasset` paths relative to `packageRoot` (POSIX, no leading slash).
 */
export function expandFilesToPack(packageRoot: string, entries: FileToPackItem[]): ExpandedPackFile[] {
  const seen = new Set<string>();
  const result: ExpandedPackFile[] = [];

  for (const entry of entries) {
    const { rawPath, base } = packPathAndBase(entry);
    const posix = toPosixAssetPath(rawPath);
    const abs = resolveUnderRoot(packageRoot, posix);
    const st = statSync(abs);
    if (st.isFile()) {
      if (!abs.toLowerCase().endsWith(".uasset")) {
        throw new Error(`filesToPack file must be a .uasset: ${rawPath}`);
      }
      const rel = path.relative(packageRoot, abs).split(path.sep).join("/");
      if (seen.has(rel)) {
        continue;
      }
      seen.add(rel);
      result.push({ posix: rel, base });
    } else if (st.isDirectory()) {
      const found: string[] = [];
      walkUassets(abs, found);
      found.sort();
      for (const f of found) {
        const rel = path.relative(packageRoot, f).split(path.sep).join("/");
        if (!seen.has(rel)) {
          seen.add(rel);
          result.push({ posix: rel, base });
        }
      }
    } else {
      throw new Error(`filesToPack entry is not a file or directory: ${rawPath}`);
    }
  }

  return result;
}
