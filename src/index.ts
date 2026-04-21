import {
  fNameToString,
  inferCookTagOptionsFromRegistry,
  loadRegistryLoose,
  mergeAssetRowsAppendOnly,
  serializeRegistryState,
} from "./unreal/index.js";
import {
  assertRegistryRows,
  loadedAssetDataFromRegistryRow,
} from "./manifestToRow.js";

function assetIdentityKey(packageName: string, assetName: string): string {
  return `${packageName}\x1f${assetName}`;
}

/**
 * Applies a JSON array of registry rows to a base AssetRegistry.bin buffer,
 * returning a new merged buffer.  Rows whose package+asset already exist in
 * the base are skipped (append-only merge — same semantics as `jjkue registry
 * merge`).
 *
 * @param baseBuf   Raw bytes of the base AssetRegistry.bin file.
 * @param rowsJson  Parsed JSON value — must be an array of registry row objects.
 *                  Each row must have `packageName` and `objectName`; all other
 *                  fields (classPath, packageFlags, chunkIds, tags, bundles) are
 *                  optional.
 * @param label     Context label used in error messages (e.g. a source file path).
 * @returns         Buffer containing the merged AssetRegistry.bin bytes.
 */
export function applyJsonToAssetRegistry(
  baseBuf: Buffer,
  rowsJson: unknown,
  label = "<rows>",
): Buffer {
  const rows = assertRegistryRows(rowsJson, label);
  const reg = loadRegistryLoose(baseBuf);

  const candidateAssets = rows.map((r, i) =>
    loadedAssetDataFromRegistryRow(r, `${label}[${i}]`),
  );

  // Build a set of already-present (packageName, assetName) pairs so we can
  // skip duplicates (append-only behaviour).
  const seen = new Set<string>(
    reg.assets.map((a) =>
      assetIdentityKey(fNameToString(a.packageName), fNameToString(a.assetName)),
    ),
  );

  const newAssets = [];
  for (const a of candidateAssets) {
    const key = assetIdentityKey(
      fNameToString(a.packageName),
      fNameToString(a.assetName),
    );
    if (!seen.has(key)) {
      seen.add(key);
      newAssets.push(a);
    }
  }

  const mergedAssets = mergeAssetRowsAppendOnly(reg.assets, newAssets);
  const cookOpts = inferCookTagOptionsFromRegistry(reg);
  const out = serializeRegistryState(
    reg.header,
    mergedAssets,
    reg.dependencySection,
    reg.packages,
    cookOpts,
  );

  return Buffer.from(out);
}
