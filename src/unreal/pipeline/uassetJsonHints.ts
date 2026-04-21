/**
 * Best-effort tag map from UAssetGUI JSON for future registry rows.
 * Structure varies by asset type; missing keys are fine until save is implemented.
 */
import { classNameFromUAssetParsed, classPackageFromUAssetParsed } from "../registry/uassetExportClassMeta.js";

export function extractTagHintsFromUAssetGuiJson(jsonText: string): Record<string, string> {
  let root: unknown;
  try {
    root = JSON.parse(jsonText) as unknown;
  } catch {
    return {};
  }
  if (!root || typeof root !== "object") {
    return {};
  }
  const o = root as Record<string, unknown>;
  const out: Record<string, string> = {};

  const take = (k: string, v: unknown) => {
    if (typeof v === "string" && v.length) {
      out[k] = v;
    }
  };

  take("PackageName", o.PackageName);
  take("ObjectName", o.ObjectName);

  const exports = o.exports ?? o.Exports;
  if (Array.isArray(exports) && exports.length > 0) {
    const first = exports[0];
    if (first && typeof first === "object") {
      const e = first as Record<string, unknown>;
      if (typeof e.Type === "string" && e.Type.length) {
        take("Class", e.Type);
      }
    }
  }

  const cn = classNameFromUAssetParsed(o);
  if (cn && !out.Class) {
    out.Class = cn;
  }
  const cp = classPackageFromUAssetParsed(o);
  if (cp) {
    out.ClassPackage = cp;
  }

  return out;
}
