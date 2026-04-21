import { BinaryReader } from "../io/binaryReader.js";
import { statSync, readFileSync } from "node:fs";
import { readFNameWire, type NameTable } from "./nameBatch.js";
import type { FNameWire } from "./fnameWire.js";

export interface LoadedPackageDataV16 {
  diskSize: bigint;
  legacyGuid: Buffer;
  cookedValid: boolean;
  cookedBytes?: Buffer;
  chunkPairs: Array<{ chunkId: Buffer; hash: Buffer }>;
  fileVersionUE4: number;
  fileVersionUE5: number;
  fileVersionLicenseeUE: number;
  flags: number;
  customVersions: Array<{ guid: Buffer; version: number }>;
  importedClasses: FNameWire[];
}

export function readAssetPackageDataV16(r: BinaryReader, table: NameTable): LoadedPackageDataV16 {
  const diskSize = r.readI64();
  const legacyGuid = r.readBytes(16);
  const cookedValid = r.readU8() !== 0;
  let cookedBytes: Buffer | undefined;
  if (cookedValid) {
    cookedBytes = r.readBytes(16);
  }
  const nChunks = r.readI32();
  const chunkPairs: Array<{ chunkId: Buffer; hash: Buffer }> = [];
  for (let i = 0; i < nChunks; i++) {
    chunkPairs.push({ chunkId: r.readBytes(12), hash: r.readBytes(20) });
  }
  const fileVersionUE4 = r.readI32();
  const fileVersionUE5 = r.readI32();
  const fileVersionLicenseeUE = r.readI32();
  const flags = r.readU32();
  const nCustom = r.readI32();
  const customVersions: Array<{ guid: Buffer; version: number }> = [];
  for (let i = 0; i < nCustom; i++) {
    customVersions.push({ guid: r.readBytes(16), version: r.readI32() });
  }
  const nImported = r.readI32();
  const importedClasses: FNameWire[] = [];
  for (let i = 0; i < nImported; i++) {
    importedClasses.push(readFNameWire(r, table));
  }
  return {
    diskSize,
    legacyGuid,
    cookedValid,
    cookedBytes,
    chunkPairs,
    fileVersionUE4,
    fileVersionUE5,
    fileVersionLicenseeUE,
    flags,
    customVersions,
    importedClasses,
  };
}

export function defaultPackageDataV16(packageNameForRow: string): LoadedPackageDataV16 {
  void packageNameForRow;
  return {
    diskSize: 0n,
    legacyGuid: Buffer.alloc(16, 0),
    cookedValid: false,
    chunkPairs: [],
    fileVersionUE4: 0,
    fileVersionUE5: 0,
    fileVersionLicenseeUE: -1,
    flags: 0,
    customVersions: [],
    importedClasses: [],
  };
}

function tryReadCustomVersionsOptimized(r: BinaryReader): Array<{ guid: Buffer; version: number }> {
  const n = r.readI32();
  if (n < 0 || n > 100_000) {
    throw new Error(`Invalid custom version count ${n}`);
  }
  const out: Array<{ guid: Buffer; version: number }> = [];
  out.length = n;
  for (let i = 0; i < n; i++) {
    out[i] = { guid: r.readBytes(16), version: r.readI32() };
  }
  return out;
}

function tryReadSummaryCore(
  r: BinaryReader,
  withSavedHash: boolean,
): {
  fileVersionUE4: number;
  fileVersionUE5: number;
  fileVersionLicenseeUE: number;
  flags: number;
  customVersions: Array<{ guid: Buffer; version: number }>;
  savedHash16?: Buffer;
} {
  const tag = r.readI32();
  if (tag !== 0x9e2a83c1 && tag !== 0xc1832a9e) {
    throw new Error(`Bad package tag 0x${(tag >>> 0).toString(16)}`);
  }
  const legacyFileVersion = r.readI32();
  if (legacyFileVersion >= 0) {
    throw new Error("Legacy UE3 package summary not supported");
  }
  if (legacyFileVersion !== -4) {
    r.readI32(); // LegacyUE3Version
  }
  const fileVersionUE4 = r.readI32();
  const fileVersionUE5 = legacyFileVersion <= -8 ? r.readI32() : 0;
  const fileVersionLicenseeUE = r.readI32();

  let savedHash16: Buffer | undefined;
  if (withSavedHash) {
    const savedHash20 = r.readBytes(20);
    savedHash16 = savedHash20.subarray(0, 16);
    r.readI32(); // TotalHeaderSize
  }

  const customVersions = legacyFileVersion <= -2 ? tryReadCustomVersionsOptimized(r) : [];
  if (!withSavedHash) {
    r.readI32(); // TotalHeaderSize
  }
  r.readFString(); // PackageName
  const flags = r.readU32();
  return {
    fileVersionUE4,
    fileVersionUE5,
    fileVersionLicenseeUE,
    flags,
    customVersions,
    savedHash16,
  };
}

/** Best-effort package metadata extraction from cooked package header for new package rows. */
export function packageDataV16FromCookedAssetFile(
  filePath: string,
  packageNameForRow: string,
): LoadedPackageDataV16 {
  const out = defaultPackageDataV16(packageNameForRow);
  try {
    const st = statSync(filePath);
    out.diskSize = BigInt(st.size);
  } catch {
    return out;
  }
  try {
    const buf = readFileSync(filePath);
    // Try UE5+ summary layout first (SavedHash+TotalHeader before CustomVersions), then legacy layout.
    let parsed:
      | ReturnType<typeof tryReadSummaryCore>
      | undefined;
    try {
      parsed = tryReadSummaryCore(new BinaryReader(buf), true);
    } catch {
      parsed = tryReadSummaryCore(new BinaryReader(buf), false);
    }
    out.fileVersionUE4 = parsed.fileVersionUE4;
    out.fileVersionUE5 = parsed.fileVersionUE5;
    out.fileVersionLicenseeUE = parsed.fileVersionLicenseeUE;
    out.flags = parsed.flags >>> 0;
    out.customVersions = parsed.customVersions;
    if (parsed.savedHash16) {
      out.legacyGuid = Buffer.from(parsed.savedHash16);
    }
  } catch {
    // Leave defaults if summary parse fails.
  }
  return out;
}
