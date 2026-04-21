import { BinaryWriter } from "../io/binaryWriter.js";
import type { LoadedAssetData, AssetBundleEntry, SoftObjectPathWire } from "./assetData.js";
import { softObjectPathWireDisplay } from "./assetData.js";
import type { AssetRegistryHeader } from "./header.js";
import { writeHeader } from "./header.js";
import type { LoadedRegistry } from "./loadRegistry.js";
import {
  buildAssetSortKey,
  compareAssetsUeSaveOrder,
  fnameWireLexicalLess,
  type FNameWire,
} from "./fnameWire.js";
import type { LoadedPackageDataV16 } from "./packageDataRw.js";
import { FixedTagStoreBuilder, type FixedTagStoreBuilderOptions } from "./fixedTagStoreBuilder.js";
import { UeNameRegistry } from "./ueNameRegistry.js";
import { buildDependencySectionPayload, type DependencySectionWire } from "./dependencyRw.js";

function writeSoftObjectPathWire(w: BinaryWriter, names: UeNameRegistry, p: SoftObjectPathWire): void {
  names.writeFName(w, p.packagePart);
  names.writeFName(w, p.assetPart);
  w.writeUtf8StringNoNul(p.subUtf8);
}

function sortedBundleEntries(bundles: AssetBundleEntry[]): AssetBundleEntry[] {
  return [...bundles]
    .sort((a, b) => {
      if (fnameWireLexicalLess(a.bundleName, b.bundleName)) {
        return -1;
      }
      if (fnameWireLexicalLess(b.bundleName, a.bundleName)) {
        return 1;
      }
      return 0;
    })
    .map((e) => ({
      bundleName: e.bundleName,
      paths: [...e.paths].sort((p1, p2) => {
        const s1 = softObjectPathWireDisplay(p1).toLowerCase();
        const s2 = softObjectPathWireDisplay(p2).toLowerCase();
        if (s1 < s2) {
          return -1;
        }
        if (s1 > s2) {
          return 1;
        }
        return 0;
      }),
    }));
}

function writeAssetBundlesUe(w: BinaryWriter, names: UeNameRegistry, bundles: AssetBundleEntry[]): void {
  const sorted = sortedBundleEntries(bundles);
  w.writeI32(sorted.length);
  for (const e of sorted) {
    names.writeFName(w, e.bundleName);
    w.writeI32(e.paths.length);
    for (const p of e.paths) {
      writeSoftObjectPathWire(w, names, p);
    }
  }
}

function writeOneAsset(
  w: BinaryWriter,
  names: UeNameRegistry,
  tagBuilder: FixedTagStoreBuilder,
  a: LoadedAssetData,
): void {
  names.writeFName(w, a.packagePath);
  names.writeFName(w, a.assetClassPathPackage);
  names.writeFName(w, a.assetClassPathAsset);
  names.writeFName(w, a.packageName);
  names.writeFName(w, a.assetName);

  const handle = tagBuilder.addTagMap(a.tags, a.tagValueTypeHints);
  w.writeU64(handle);

  writeAssetBundlesUe(w, names, a.bundles);

  const chunks = [...a.chunkIds].sort((x, y) => x - y);
  w.writeI32(chunks.length);
  for (const c of chunks) {
    w.writeI32(c);
  }
  w.writeU32(a.packageFlags >>> 0);
}

function writeAssetPackageDataV16Ue(w: BinaryWriter, names: UeNameRegistry, p: LoadedPackageDataV16): void {
  w.writeI64(p.diskSize);
  w.writeBytes(p.legacyGuid);
  w.writeU8(p.cookedValid ? 1 : 0);
  if (p.cookedValid) {
    if (!p.cookedBytes || p.cookedBytes.length !== 16) {
      throw new Error("cookedBytes must be 16 bytes when cookedValid");
    }
    w.writeBytes(p.cookedBytes);
  }
  w.writeI32(p.chunkPairs.length);
  for (const c of p.chunkPairs) {
    if (c.chunkId.length !== 12 || c.hash.length !== 20) {
      throw new Error("Invalid chunk pair buffer sizes");
    }
    w.writeBytes(c.chunkId);
    w.writeBytes(c.hash);
  }
  w.writeI32(p.fileVersionUE4);
  w.writeI32(p.fileVersionUE5);
  w.writeI32(p.fileVersionLicenseeUE);
  w.writeU32(p.flags >>> 0);
  w.writeI32(p.customVersions.length);
  for (const cv of p.customVersions) {
    w.writeBytes(cv.guid);
    w.writeI32(cv.version);
  }
  w.writeI32(p.importedClasses.length);
  for (const cls of p.importedClasses) {
    names.writeFName(w, cls);
  }
}

function sortPackages(
  packages: Array<{ name: FNameWire; data: LoadedPackageDataV16 }>,
): Array<{ name: FNameWire; data: LoadedPackageDataV16 }> {
  return [...packages].sort((a, b) => {
    if (fnameWireLexicalLess(a.name, b.name)) {
      return -1;
    }
    if (fnameWireLexicalLess(b.name, a.name)) {
      return 1;
    }
    return 0;
  });
}

function sortAssetsForUeSave(assets: LoadedAssetData[]): LoadedAssetData[] {
  return [...assets].sort((a, b) =>
    compareAssetsUeSaveOrder(
      buildAssetSortKey(a.packageName, a.assetName),
      buildAssetSortKey(b.packageName, b.assetName),
    ),
  );
}

/** Optional `FAssetRegistrySerializationOptions::CookTagsAsName` / `CookTagsAsPath` for tag store rebuild. */
export type SerializeRegistryTagOptions = Pick<
  FixedTagStoreBuilderOptions,
  "cookTagsAsName" | "cookTagsAsPath"
>;

/**
 * `FAssetRegistryState::Save` + `FAssetRegistryWriter` destructor layout:
 * header → name batch → fixed store → body (assets, deps, packages).
 */
export function serializeRegistryStateUe(
  header: AssetRegistryHeader,
  assets: LoadedAssetData[],
  dependencySection: Buffer | DependencySectionWire,
  packages: Array<{ name: FNameWire; data: LoadedPackageDataV16 }>,
  tagOptions?: SerializeRegistryTagOptions,
): Buffer {
  const sortedAssets = sortAssetsForUeSave(assets);
  const sortedPackages = sortPackages(packages);

  const names = new UeNameRegistry();
  const tagBuilder = new FixedTagStoreBuilder({
    fileVersion: header.version,
    cookTagsAsName: tagOptions?.cookTagsAsName,
    cookTagsAsPath: tagOptions?.cookTagsAsPath,
  });
  const mem = new BinaryWriter();

  const dependencySectionBytes = Buffer.isBuffer(dependencySection)
    ? dependencySection
    : buildDependencySectionPayload(dependencySection, names);
  mem.writeI32(sortedAssets.length);
  for (const a of sortedAssets) {
    writeOneAsset(mem, names, tagBuilder, a);
  }
  mem.writeI64(BigInt(dependencySectionBytes.length));
  mem.writeBytes(dependencySectionBytes);
  mem.writeI32(sortedPackages.length);
  for (const p of sortedPackages) {
    names.writeFName(mem, p.name);
    writeAssetPackageDataV16Ue(mem, names, p.data);
  }

  const bodySize = mem.length;
  const storeBuf = tagBuilder.serialize(names);
  mem.writeBytes(storeBuf);

  const full = mem.toBuffer();
  const body = full.subarray(0, bodySize);
  const store = full.subarray(bodySize);

  const out = new BinaryWriter();
  writeHeader(out, header);
  names.appendNameBatchTo(out);
  out.writeBytes(store);
  out.writeBytes(body);
  return out.toBuffer();
}

export function serializeLoadedRegistryUe(reg: LoadedRegistry): Buffer {
  return serializeRegistryStateUe(reg.header, reg.assets, reg.dependencySection, reg.packages);
}
