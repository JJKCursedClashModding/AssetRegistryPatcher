import { BinaryReader } from "../io/binaryReader.js";
import {
  ASSET_PACKAGE_DATA_HAS_PACKAGE_LOCATION_ENUM,
  CLASS_PATHS_ENUM,
  FIXED_TAG_BEGIN_MAGIC,
  FIXED_TAG_END_MAGIC,
  MARSHALLED_TEXT_UTF8_ENUM,
} from "./constants.js";
import { readFName, type NameTable } from "./nameBatch.js";

const enum EValueType {
  AnsiString = 0,
  WideString = 1,
  NumberlessName = 2,
  Name = 3,
  NumberlessExportPath = 4,
  ExportPath = 5,
  LocalizedText = 6,
}

export type TagValueTypeId = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ParsedFixedStore {
  texts: string[];
  numberlessNames: string[];
  names: string[];
  numberlessExportPaths: string[];
  exportPaths: string[];
  numberlessPairKeys: string[];
  numberlessPairValueIds: number[];
  pairKeys: string[];
  pairValueIds: number[];
}

/** Internal buffers for resolving deduplicated string tables */
export type ParsedFixedStoreInternal = ParsedFixedStore & {
  _ansiOffsets: number[];
  _wideOffsets: number[];
  _ansiStrings: Buffer;
  _wideStrings: Buffer;
};

function valueIdFromInt(u: number): { type: EValueType; index: number } {
  const type = (u & 7) as EValueType;
  const index = u >>> 3;
  return { type, index };
}

function readTopLevelPath(r: BinaryReader, table: NameTable): string {
  const pkg = readFName(r, table);
  const asset = readFName(r, table);
  if (!asset || asset.length === 0) {
    return pkg;
  }
  return `${pkg}.${asset}`;
}

function readAssetRegistryExportPath(r: BinaryReader, table: NameTable, fileVersion: number): string {
  if (fileVersion < CLASS_PATHS_ENUM) {
    throw new Error("Legacy class FName export path not implemented");
  }
  const classPath = readTopLevelPath(r, table);
  const objectName = readFName(r, table);
  const packageName = readFName(r, table);
  if (classPath.length === 0) {
    if (!objectName.length) {
      return packageName;
    }
    return `${packageName}.${objectName}`;
  }
  return `${classPath}'${packageName}.${objectName}'`;
}

function readNumberlessExportPath(r: BinaryReader, table: NameTable, fileVersion: number): string {
  const full = readAssetRegistryExportPath(r, table, fileVersion);
  return full;
}

function readMarshalledText(r: BinaryReader, fileVersion: number): string {
  if (fileVersion >= MARSHALLED_TEXT_UTF8_ENUM) {
    return r.readUtf8StringNoWidth();
  }
  return r.readFString();
}

function readAnsiSlice(strings: Buffer, offsets: number[], i: number): string {
  const start = offsets[i]!;
  let end = start;
  while (end < strings.length && strings[end] !== 0) {
    end++;
  }
  return strings.subarray(start, end).toString("latin1");
}

function readWideSlice(strings: Buffer, offsets: number[], i: number): string {
  const start = offsets[i]! * 2;
  let end = start;
  while (end + 1 < strings.length) {
    const c = strings.readUInt16LE(end);
    if (c === 0) {
      break;
    }
    end += 2;
  }
  return strings.subarray(start, end).toString("utf16le");
}

function resolveValue(store: ParsedFixedStoreInternal, id: number): string {
  const { type, index } = valueIdFromInt(id);
  switch (type) {
    case EValueType.AnsiString:
      return readAnsiSlice(
        store._ansiStrings,
        store._ansiOffsets,
        index,
      );
    case EValueType.WideString:
      return readWideSlice(
        store._wideStrings,
        store._wideOffsets,
        index,
      );
    case EValueType.NumberlessName:
      return store.numberlessNames[index] ?? `?nlname[${index}]`;
    case EValueType.Name:
      return store.names[index] ?? `?name[${index}]`;
    case EValueType.NumberlessExportPath:
      return store.numberlessExportPaths[index] ?? `?nlexp[${index}]`;
    case EValueType.ExportPath:
      return store.exportPaths[index] ?? `?exp[${index}]`;
    case EValueType.LocalizedText:
      return store.texts[index] ?? `?text[${index}]`;
    default:
      return `?vt${type}[${index}]`;
  }
}

export function loadFixedTagStore(r: BinaryReader, fileVersion: number, nameTable: NameTable): ParsedFixedStoreInternal {
  const magic = r.readU32();
  if (magic !== FIXED_TAG_BEGIN_MAGIC) {
    throw new Error(`Fixed tag store bad begin magic: 0x${magic.toString(16)}`);
  }

  const cn = r.readI32();
  const nNames = r.readI32();
  const cnExpNl = r.readI32();
  const cnExp = r.readI32();
  const cnText = r.readI32();
  const cnAnsiOff = r.readI32();
  const cnWideOff = r.readI32();
  const cnAnsiBytes = r.readI32();
  const cnWideUnits = r.readI32();
  const cnNlPairs = r.readI32();
  const cnPairs = r.readI32();

  const textBlobLen = r.readU32();
  const textEnd = r.offset + textBlobLen;
  const texts: string[] = [];
  const textReader = new BinaryReader(r.buf.subarray(r.offset, textEnd));
  for (let i = 0; i < cnText; i++) {
    texts.push(readMarshalledText(textReader, fileVersion));
  }
  if (textReader.offset !== textBlobLen) {
    throw new Error(
      `Fixed tag text blob consumed ${textReader.offset}, expected ${textBlobLen}`,
    );
  }
  r.skip(textBlobLen);

  const storeSerializerVersion =
    fileVersion < CLASS_PATHS_ENUM
      ? CLASS_PATHS_ENUM
      : fileVersion <= ASSET_PACKAGE_DATA_HAS_PACKAGE_LOCATION_ENUM
        ? ASSET_PACKAGE_DATA_HAS_PACKAGE_LOCATION_ENUM
        : fileVersion;

  const numberlessNames: string[] = [];
  for (let i = 0; i < cn; i++) {
    numberlessNames.push(readFName(r, nameTable));
  }
  const names: string[] = [];
  for (let i = 0; i < nNames; i++) {
    names.push(readFName(r, nameTable));
  }
  const numberlessExportPaths: string[] = [];
  for (let i = 0; i < cnExpNl; i++) {
    numberlessExportPaths.push(readNumberlessExportPath(r, nameTable, storeSerializerVersion));
  }
  const exportPaths: string[] = [];
  for (let i = 0; i < cnExp; i++) {
    exportPaths.push(readAssetRegistryExportPath(r, nameTable, storeSerializerVersion));
  }

  const ansiOffsets: number[] = [];
  for (let i = 0; i < cnAnsiOff; i++) {
    ansiOffsets.push(r.readU32());
  }
  const wideOffsets: number[] = [];
  for (let i = 0; i < cnWideOff; i++) {
    wideOffsets.push(r.readU32());
  }
  const ansiStrings = r.readBytes(cnAnsiBytes);
  const wideStrings = r.readBytes(cnWideUnits * 2);

  const numberlessPairKeys: string[] = [];
  const numberlessPairValueIds: number[] = [];
  for (let i = 0; i < cnNlPairs; i++) {
    numberlessPairKeys.push(readFName(r, nameTable));
    numberlessPairValueIds.push(r.readU32());
  }
  const pairKeys: string[] = [];
  const pairValueIds: number[] = [];
  for (let i = 0; i < cnPairs; i++) {
    pairKeys.push(readFName(r, nameTable));
    pairValueIds.push(r.readU32());
  }

  const endMagic = r.readU32();
  if (endMagic !== FIXED_TAG_END_MAGIC) {
    throw new Error(`Fixed tag store bad end magic: 0x${endMagic.toString(16)}`);
  }

  const out: ParsedFixedStoreInternal = {
    texts,
    numberlessNames,
    names,
    numberlessExportPaths,
    exportPaths,
    numberlessPairKeys,
    numberlessPairValueIds,
    pairKeys,
    pairValueIds,
    _ansiOffsets: ansiOffsets,
    _wideOffsets: wideOffsets,
    _ansiStrings: ansiStrings,
    _wideStrings: wideStrings,
  };
  void resolveValue;
  return out;
}

export function partialMapHandleFromUint64(h: bigint): {
  hasNumberlessKeys: boolean;
  num: number;
  pairBegin: number;
} {
  const hasNumberlessKeys = (h >> 63n) !== 0n;
  const num = Number((h >> 32n) & 0xffffn);
  const pairBegin = Number(h & 0xffffffffn);
  return { hasNumberlessKeys, num, pairBegin };
}

export function resolveTagMap(store: ParsedFixedStoreInternal, mapHandle: bigint): Record<string, string> {
  if (mapHandle === 0n) {
    return {};
  }
  const { hasNumberlessKeys, num, pairBegin } = partialMapHandleFromUint64(mapHandle);
  const out: Record<string, string> = {};
  if (hasNumberlessKeys) {
    for (let i = 0; i < num; i++) {
      const k = store.numberlessPairKeys[pairBegin + i]!;
      const vid = store.numberlessPairValueIds[pairBegin + i]!;
      out[k] = resolveValue(store, vid);
    }
  } else {
    for (let i = 0; i < num; i++) {
      const k = store.pairKeys[pairBegin + i]!;
      const vid = store.pairValueIds[pairBegin + i]!;
      out[k] = resolveValue(store, vid);
    }
  }
  return out;
}

export function resolveTagMapTypeIds(
  store: ParsedFixedStoreInternal,
  mapHandle: bigint,
): Record<string, TagValueTypeId> {
  if (mapHandle === 0n) {
    return {};
  }
  const { hasNumberlessKeys, num, pairBegin } = partialMapHandleFromUint64(mapHandle);
  const out: Record<string, TagValueTypeId> = {};
  if (hasNumberlessKeys) {
    for (let i = 0; i < num; i++) {
      const k = store.numberlessPairKeys[pairBegin + i]!;
      const vid = store.numberlessPairValueIds[pairBegin + i]!;
      out[k] = (vid & 7) as TagValueTypeId;
    }
  } else {
    for (let i = 0; i < num; i++) {
      const k = store.pairKeys[pairBegin + i]!;
      const vid = store.pairValueIds[pairBegin + i]!;
      out[k] = (vid & 7) as TagValueTypeId;
    }
  }
  return out;
}
