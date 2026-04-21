import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Copy same-stem `.uexp` / `.ubulk` from the source asset’s folder into the destination asset’s folder.
 * Destination files use the **destination** basename (so `outputAssetPath` renames stay consistent).
 * If a destination sidecar already exists (e.g. UAssetGUI `fromjson` wrote `.uexp`), it is **not** overwritten.
 */
export function copySidecarsBesideUasset(sourceUasset: string, destUasset: string): void {
  const srcDir = path.dirname(sourceUasset);
  const srcBase = path.basename(sourceUasset, path.extname(sourceUasset));
  const destDir = path.dirname(destUasset);
  const destBase = path.basename(destUasset, path.extname(destUasset));
  for (const ext of [".uexp", ".ubulk"] as const) {
    const src = path.join(srcDir, srcBase + ext);
    if (!existsSync(src)) {
      continue;
    }
    const out = path.join(destDir, destBase + ext);
    if (existsSync(out)) {
      continue;
    }
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, out);
  }
}
