/**
 * Read UObject class short name and defining `/Script/...` package from UAssetGUI / UAssetAPI JSON.
 */

function importRowForExport0Class(
  parsed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const exportsRaw = parsed.Exports ?? parsed.exports;
  const importsRaw = parsed.Imports ?? parsed.imports;
  if (!Array.isArray(exportsRaw) || exportsRaw.length === 0 || !Array.isArray(importsRaw)) {
    return undefined;
  }
  const first = exportsRaw[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  const classIndex = (first as Record<string, unknown>).ClassIndex;
  if (typeof classIndex !== "number" || !Number.isInteger(classIndex) || classIndex >= 0) {
    return undefined;
  }
  const importIdx = -classIndex - 1;
  if (importIdx < 0 || importIdx >= importsRaw.length) {
    return undefined;
  }
  const imp = importsRaw[importIdx];
  if (!imp || typeof imp !== "object") {
    return undefined;
  }
  return imp as Record<string, unknown>;
}

function scriptPackageFromImportOuterChain(
  importsRaw: unknown[],
  startOuter: unknown,
): string | undefined {
  if (typeof startOuter !== "number" || startOuter >= 0 || !Number.isInteger(startOuter)) {
    return undefined;
  }
  const visited = new Set<number>();
  let outerIdx: unknown = startOuter;
  while (typeof outerIdx === "number" && outerIdx < 0) {
    const oi = -outerIdx - 1;
    if (oi < 0 || oi >= importsRaw.length || visited.has(oi)) {
      return undefined;
    }
    visited.add(oi);
    const row = importsRaw[oi];
    if (!row || typeof row !== "object") {
      return undefined;
    }
    const io = row as Record<string, unknown>;
    const objectName = io.ObjectName;
    if (typeof objectName === "string" && objectName.startsWith("/Script/")) {
      return objectName;
    }
    outerIdx = io.OuterIndex;
  }
  return undefined;
}

export function classNameFromUAssetParsed(parsed: Record<string, unknown>): string | undefined {
  const imp = importRowForExport0Class(parsed);
  if (!imp) {
    return undefined;
  }
  const objectName = imp.ObjectName;
  return typeof objectName === "string" && objectName.length > 0 ? objectName : undefined;
}

export function classPackageFromUAssetParsed(parsed: Record<string, unknown>): string | undefined {
  const importsRaw = parsed.Imports ?? parsed.imports;
  if (!Array.isArray(importsRaw)) {
    return undefined;
  }
  const imp = importRowForExport0Class(parsed);
  if (!imp) {
    return undefined;
  }
  if (imp.ClassName === "Class") {
    const fromOuter = scriptPackageFromImportOuterChain(importsRaw, imp.OuterIndex);
    if (fromOuter !== undefined) {
      return fromOuter;
    }
  }
  const cp = imp.ClassPackage;
  return typeof cp === "string" && cp.length > 0 ? cp : undefined;
}
