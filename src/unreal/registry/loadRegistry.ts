import { BinaryReader } from "../io/binaryReader.js";
import { readAssetData, type LoadedAssetData } from "./assetData.js";
import { loadFixedTagStore, type ParsedFixedStoreInternal } from "./fixedStore.js";
import { readAndValidateHeader } from "./header.js";
import { loadNameBatch, readFNameWire, type NameTable } from "./nameBatch.js";
import type { FNameWire } from "./fnameWire.js";
import { readAssetPackageDataV16, type LoadedPackageDataV16 } from "./packageDataRw.js";
import { parseDependencySectionPayload, type DependencySectionWire } from "./dependencyRw.js";

export interface LoadedRegistry {
  header: ReturnType<typeof readAndValidateHeader>;
  nameTable: NameTable;
  store: ParsedFixedStoreInternal;
  assets: LoadedAssetData[];
  /** Raw dependency section v1 blob (preserved on save). */
  dependencySection: Buffer;
  /** Parsed dependency graph section (NumDependencies + nodes). */
  dependencyData: DependencySectionWire;
  /** Package name + `FAssetPackageData` per row (v16). */
  packages: Array<{ name: FNameWire; data: LoadedPackageDataV16 }>;
  /** Byte offset in the input buffer after successful parse (should equal buffer.length). */
  endOffset: number;
  /** Set when `keepSourceBuffer` was true; enables byte-identical output via {@link verbatimRegistryBytes}. */
  sourceBuffer?: Buffer;
}

export function loadRegistryLoose(
  buffer: Buffer,
  options?: { keepSourceBuffer?: boolean },
): LoadedRegistry {
  const r = new BinaryReader(buffer);
  const header = readAndValidateHeader(r);
  const nameTable = loadNameBatch(r);
  const store = loadFixedTagStore(r, header.version, nameTable);

  const numAssets = r.readI32();
  if (numAssets < 0 || numAssets > 50_000_000) {
    throw new Error(`Suspicious asset count: ${numAssets}`);
  }
  const assets: LoadedAssetData[] = [];
  for (let i = 0; i < numAssets; i++) {
    assets.push(readAssetData(r, nameTable, store));
  }

  const depSectionSize = r.readI64();
  if (depSectionSize < 0n) {
    throw new Error(`Invalid dependency section size: ${depSectionSize}`);
  }
  const depN = Number(depSectionSize);
  if (depN > r.remaining()) {
    throw new Error(`Dependency section size ${depN} exceeds remaining ${r.remaining()} bytes`);
  }
  const depOff = r.offset;
  r.skip(depN);
  const dependencySection = buffer.subarray(depOff, depOff + depN);
  const dependencyData = parseDependencySectionPayload(dependencySection, nameTable);

  const numPackages = r.readI32();
  if (numPackages < 0 || numPackages > 10_000_000) {
    throw new Error(`Suspicious package data count: ${numPackages}`);
  }
  const packages: Array<{ name: FNameWire; data: LoadedPackageDataV16 }> = [];
  for (let i = 0; i < numPackages; i++) {
    const name = readFNameWire(r, nameTable);
    const data = readAssetPackageDataV16(r, nameTable);
    packages.push({ name, data });
  }

  if (r.offset !== buffer.length) {
    throw new Error(
      `Trailing bytes after registry parse: offset ${r.offset}, file length ${buffer.length}`,
    );
  }

  return {
    header,
    nameTable,
    store,
    assets,
    dependencySection,
    dependencyData,
    packages,
    endOffset: r.offset,
    sourceBuffer: options?.keepSourceBuffer ? buffer : undefined,
  };
}

/** Returns the original `.bin` bytes when the registry was loaded with `keepSourceBuffer: true`. */
export function verbatimRegistryBytes(reg: LoadedRegistry): Buffer | undefined {
  return reg.sourceBuffer;
}
