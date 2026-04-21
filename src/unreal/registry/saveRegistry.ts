import type { LoadedAssetData } from "./assetData.js";
import { SUPPORTED_REGISTRY_VERSION } from "./constants.js";
import type { AssetRegistryHeader } from "./header.js";
import { assetIdentityKey, buildBaseIdentitySet } from "./identity.js";
import type { LoadedRegistry } from "./loadRegistry.js";
import { defaultPackageDataV16, type LoadedPackageDataV16 } from "./packageDataRw.js";
import { fNameToString, type FNameWire } from "./fnameWire.js";
import { serializeRegistryStateUe } from "./ueSerializeRegistry.js";
import { emptyDependencySection, type DependencySectionWire } from "./dependencyRw.js";
import type { TagValueTypeId } from "./fixedStore.js";

export interface CookTagOptions {
  cookTagsAsName?: ReadonlySet<string>;
  cookTagsAsPath?: ReadonlySet<string>;
}

const enum EValueType {
  NumberlessName = 2,
  Name = 3,
  NumberlessExportPath = 4,
  ExportPath = 5,
}

/** Infer UE `CookTagsAsName` / `CookTagsAsPath` from fixed-tag value-id type usage in a loaded cooked registry. */
export function inferCookTagOptionsFromRegistry(reg: LoadedRegistry): CookTagOptions {
  const asName = new Set<string>();
  const asPath = new Set<string>();
  const addFrom = (keys: string[], valueIds: number[]) => {
    const n = Math.min(keys.length, valueIds.length);
    for (let i = 0; i < n; i++) {
      const k = keys[i]!;
      const t = (valueIds[i]! >>> 0) & 7;
      if (t === EValueType.NumberlessName || t === EValueType.Name) {
        asName.add(k);
      } else if (t === EValueType.NumberlessExportPath || t === EValueType.ExportPath) {
        asPath.add(k);
      }
    }
  };
  addFrom(reg.store.numberlessPairKeys, reg.store.numberlessPairValueIds);
  addFrom(reg.store.pairKeys, reg.store.pairValueIds);
  return { cookTagsAsName: asName, cookTagsAsPath: asPath };
}

/**
 * Replace rows that share (packageName, assetName) with staged versions; append rows for new identities.
 * Preserves original row order for existing keys; new keys are appended in staged iteration order.
 */
export function mergeAssetRowsForSave(base: LoadedAssetData[], staged: LoadedAssetData[]): LoadedAssetData[] {
  const byKey = new Map<string, LoadedAssetData>();
  const order: string[] = [];
  for (const a of base) {
    const k = assetIdentityKey(fNameToString(a.packageName), fNameToString(a.assetName));
    byKey.set(k, a);
    order.push(k);
  }
  for (const a of staged) {
    const k = assetIdentityKey(fNameToString(a.packageName), fNameToString(a.assetName));
    if (byKey.has(k)) {
      const prev = byKey.get(k)!;
      const mergedTypeHints: Record<string, TagValueTypeId> = {};
      const prevHints: Partial<Record<string, TagValueTypeId>> = prev.tagValueTypeHints ?? {};
      const nextHints: Partial<Record<string, TagValueTypeId>> = a.tagValueTypeHints ?? {};
      for (const tagKey of Object.keys({ ...prev.tags, ...a.tags })) {
        if (nextHints[tagKey] !== undefined) {
          mergedTypeHints[tagKey] = nextHints[tagKey]!;
        } else if (nextHints[tagKey] === undefined && a.tags[tagKey] === prev.tags[tagKey] && prevHints[tagKey] !== undefined) {
          // Preserve source fixed-store type when value is unchanged and new row has no explicit type.
          mergedTypeHints[tagKey] = prevHints[tagKey]!;
        } else if (prevHints[tagKey] !== undefined && nextHints[tagKey] === undefined && a.tags[tagKey] === undefined) {
          mergedTypeHints[tagKey] = prevHints[tagKey]!;
        }
      }
      byKey.set(k, {
        ...a,
        tags: { ...prev.tags, ...a.tags },
        tagValueTypeHints: mergedTypeHints,
      });
    } else {
      order.push(k);
      byKey.set(k, a);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/** Append default package rows for package names that appear in staged assets but not in the base registry. */
export function mergePackageRowsForSave(
  basePackages: Array<{ name: FNameWire; data: LoadedPackageDataV16 }>,
  stagedAssets: LoadedAssetData[],
  packageDataByPackageName?: ReadonlyMap<string, LoadedPackageDataV16>,
): Array<{ name: FNameWire; data: LoadedPackageDataV16 }> {
  const known = new Set(basePackages.map((p) => fNameToString(p.name)));
  const out = [...basePackages];
  for (const a of stagedAssets) {
    const pn = fNameToString(a.packageName);
    if (!known.has(pn)) {
      out.push({
        name: a.packageName,
        data: packageDataByPackageName?.get(pn) ?? defaultPackageDataV16(pn),
      });
      known.add(pn);
    }
  }
  return out;
}

/** Append-only merge: fails if any staged row already exists in the base asset list. */
export function mergeAssetRowsAppendOnly(base: LoadedAssetData[], extra: LoadedAssetData[]): LoadedAssetData[] {
  const seen = buildBaseIdentitySet(base);
  for (const a of extra) {
    const k = assetIdentityKey(fNameToString(a.packageName), fNameToString(a.assetName));
    if (seen.has(k)) {
      throw new Error(
        `Registry merge collision: package+asset already exists: ${JSON.stringify(fNameToString(a.packageName))} / ${JSON.stringify(fNameToString(a.assetName))}`,
      );
    }
    seen.add(k);
  }
  return [...base, ...extra];
}

/** v16 registry with no assets, no dependency graph, and no package rows (valid for `loadRegistryLoose`). */
export function buildEmptyAssetRegistryBin(): Buffer {
  const header: AssetRegistryHeader = {
    version: SUPPORTED_REGISTRY_VERSION,
    bFilterEditorOnlyData: true,
  };
  return serializeRegistryStateUe(header, [], emptyDependencySection(), []);
}

/** Serialize v16 registry using UE `FAssetRegistryState::Save` layout (name batch hashes, body/store order, sorted rows). */
export function serializeRegistryState(
  header: AssetRegistryHeader,
  assets: LoadedAssetData[],
  dependencySection: Buffer | DependencySectionWire,
  packages: Array<{ name: FNameWire; data: LoadedPackageDataV16 }>,
  tagOptions?: CookTagOptions,
): Buffer {
  return serializeRegistryStateUe(header, assets, dependencySection, packages, tagOptions);
}

/**
 * Apply staged/rebuilt `FAssetData` rows (replace by identity or append), merge package section, serialize v16.
 */
export function saveRegistryWithStagedAssets(
  reg: LoadedRegistry,
  stagedAssets: LoadedAssetData[],
  tagOptions?: CookTagOptions,
  packageDataByPackageName?: ReadonlyMap<string, LoadedPackageDataV16>,
): Buffer {
  const assets = mergeAssetRowsForSave(reg.assets, stagedAssets);
  void packageDataByPackageName;
  return serializeRegistryStateUe(reg.header, assets, reg.dependencyData, [], tagOptions);
}

/**
 * Serialize only the staged/rebuilt rows as a standalone v16 registry.
 * Carries the input header version/filter flags, clears dependency data, and writes package rows
 * for packages referenced by staged assets.
 */
export function saveRegistryWithOnlyStagedAssets(
  reg: LoadedRegistry,
  stagedAssets: LoadedAssetData[],
  tagOptions?: CookTagOptions,
  packageDataByPackageName?: ReadonlyMap<string, LoadedPackageDataV16>,
): Buffer {
  void packageDataByPackageName;
  return serializeRegistryStateUe(
    reg.header,
    stagedAssets,
    emptyDependencySection(),
    [],
    tagOptions,
  );
}
