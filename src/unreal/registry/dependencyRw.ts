import { BinaryReader } from "../io/binaryReader.js";
import { BinaryWriter } from "../io/binaryWriter.js";
import type { FNameWire } from "./fnameWire.js";
import { readFNameWire, type NameTable } from "./nameBatch.js";
import type { UeNameRegistry } from "./ueNameRegistry.js";

// UE `FDependsNode` uses TPropertyCombinationSet storage-bit counts, not `1 << BitWidth`:
// PackageFlagWidth=3 -> StorageBitCount=5, ManageFlagWidth=2 -> StorageBitCount=3.
const PACKAGE_FLAG_SET_WIDTH = 5;
const MANAGE_FLAG_SET_WIDTH = 3;

export interface AssetIdentifierWire {
  packageName?: FNameWire;
  primaryAssetType?: FNameWire;
  objectName?: FNameWire;
  valueName?: FNameWire;
}

export interface DependsNodeWire {
  identifier: AssetIdentifierWire;
  packageDependencies: number[];
  packageFlagWords: number[];
  nameDependencies: number[];
  manageDependencies: number[];
  manageFlagWords: number[];
  referencers: number[];
}

export interface DependencySectionWire {
  nodes: DependsNodeWire[];
}

function calcFlagWords(numDeps: number, flagSetWidth: number): number {
  const numBits = numDeps * flagSetWidth;
  return Math.floor((numBits + 31) / 32);
}

function readI32Array(r: BinaryReader): number[] {
  const n = r.readI32();
  if (n < 0 || n > 50_000_000) {
    throw new Error(`Invalid dependency array size ${n}`);
  }
  const out: number[] = [];
  out.length = n;
  for (let i = 0; i < n; i++) {
    out[i] = r.readI32();
  }
  return out;
}

function readU32Array(r: BinaryReader, n: number): number[] {
  const out: number[] = [];
  out.length = n;
  for (let i = 0; i < n; i++) {
    out[i] = r.readU32();
  }
  return out;
}

function writeI32Array(w: BinaryWriter, values: number[]): void {
  w.writeI32(values.length);
  for (const v of values) {
    w.writeI32(v);
  }
}

function readAssetIdentifier(r: BinaryReader, table: NameTable): AssetIdentifierWire {
  const bits = r.readU8();
  const out: AssetIdentifierWire = {};
  if (bits & (1 << 0)) {
    out.packageName = readFNameWire(r, table);
  }
  if (bits & (1 << 1)) {
    out.primaryAssetType = readFNameWire(r, table);
  }
  if (bits & (1 << 2)) {
    out.objectName = readFNameWire(r, table);
  }
  if (bits & (1 << 3)) {
    out.valueName = readFNameWire(r, table);
  }
  return out;
}

function writeAssetIdentifier(w: BinaryWriter, names: UeNameRegistry, id: AssetIdentifierWire): void {
  let bits = 0;
  if (id.packageName) {
    bits |= 1 << 0;
  }
  if (id.primaryAssetType) {
    bits |= 1 << 1;
  }
  if (id.objectName) {
    bits |= 1 << 2;
  }
  if (id.valueName) {
    bits |= 1 << 3;
  }
  w.writeU8(bits);
  if (id.packageName) {
    names.writeFName(w, id.packageName);
  }
  if (id.primaryAssetType) {
    names.writeFName(w, id.primaryAssetType);
  }
  if (id.objectName) {
    names.writeFName(w, id.objectName);
  }
  if (id.valueName) {
    names.writeFName(w, id.valueName);
  }
}

/** Payload format inside `DependencySectionSize` (starts with `NumDependencies`). */
export function parseDependencySectionPayload(buf: Buffer, table: NameTable): DependencySectionWire {
  const r = new BinaryReader(buf);
  const numNodes = r.readI32();
  if (numNodes < 0 || numNodes > 50_000_000) {
    throw new Error(`Invalid NumDependencies ${numNodes}`);
  }
  const nodes: DependsNodeWire[] = [];
  nodes.length = numNodes;
  for (let i = 0; i < numNodes; i++) {
    const identifier = readAssetIdentifier(r, table);

    const packageDependencies = readI32Array(r);
    const packageFlagWords = readU32Array(
      r,
      calcFlagWords(packageDependencies.length, PACKAGE_FLAG_SET_WIDTH),
    );

    const nameDependencies = readI32Array(r);

    const manageDependencies = readI32Array(r);
    const manageFlagWords = readU32Array(
      r,
      calcFlagWords(manageDependencies.length, MANAGE_FLAG_SET_WIDTH),
    );

    const referencers = readI32Array(r);
    nodes[i] = {
      identifier,
      packageDependencies,
      packageFlagWords,
      nameDependencies,
      manageDependencies,
      manageFlagWords,
      referencers,
    };
  }
  if (r.offset !== buf.length) {
    throw new Error(`Dependency payload trailing bytes: consumed ${r.offset}, length ${buf.length}`);
  }
  return { nodes };
}

export function buildDependencySectionPayload(dep: DependencySectionWire, names: UeNameRegistry): Buffer {
  const w = new BinaryWriter();
  w.writeI32(dep.nodes.length);
  for (const n of dep.nodes) {
    writeAssetIdentifier(w, names, n.identifier);

    writeI32Array(w, n.packageDependencies);
    for (const word of n.packageFlagWords) {
      w.writeU32(word >>> 0);
    }

    writeI32Array(w, n.nameDependencies);

    writeI32Array(w, n.manageDependencies);
    for (const word of n.manageFlagWords) {
      w.writeU32(word >>> 0);
    }

    writeI32Array(w, n.referencers);
  }
  return w.toBuffer();
}

export function emptyDependencySection(): DependencySectionWire {
  return { nodes: [] };
}

