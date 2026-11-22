import { BinaryWriter } from "../io/binaryWriter.js";
import {
  FIXED_TAG_BEGIN_MAGIC,
  FIXED_TAG_END_MAGIC,
  MARSHALLED_TEXT_UTF8_ENUM,
} from "./constants.js";
import {
  assetRegistryExportPathDisplay,
  isExportPathWireAllNumberless,
  parseAssetRegistryExportPathFromDisplay,
  parseFNameWireFromRegistryTag,
  type AssetRegistryExportPathWire,
} from "./assetData.js";
import { compareFNameWire, plainFName, type FNameWire } from "./fnameWire.js";
import type { UeNameRegistry } from "./ueNameRegistry.js";
import type { TagValueTypeId } from "./fixedStore.js";

const enum EValueType {
  AnsiString = 0,
  WideString = 1,
  NumberlessName = 2,
  Name = 3,
  NumberlessExportPath = 4,
  ExportPath = 5,
  LocalizedText = 6,
}

function makeValueId(type: EValueType, index: number): number {
  return type | (index << 3);
}

function toPartialMapHandle(hasNumberlessKeys: boolean, num: number, pairBegin: number): bigint {
  if (num === 0) {
    return 0n;
  }
  // FPartialMapHandle::Num is a uint16 (`check(Map.Num() <= TNumericLimits<uint16>::Max())`).
  if (num > 0xffff) {
    throw new Error(`Tag map has ${num} tags; the cooked registry allows at most 65535 per asset`);
  }
  const begin = BigInt(pairBegin) & 0xffffffffn;
  const keyMode = hasNumberlessKeys ? 1n << 63n : 0n;
  return keyMode | (BigInt(num) << 32n) | begin;
}

/** `FStoreBuilder::AddTagMap` sorts keys with `FName::LexicalLess` (= `FName::Compare`). */
function tagKeysSortedLexical(keys: string[]): string[] {
  return keys
    .map((k) => ({ k, f: parseFNameWireFromRegistryTag(k) }))
    .sort((a, b) => compareFNameWire(a.f, b.f))
    .map((e) => e.k);
}

/**
 * `FTextStringHelper::IsComplexText` (Text.cpp): a case-sensitive prefix peek at the start of
 * the buffer (no whitespace skipping) for any text-history marker. LOCGEN_DATE also covers
 * LOCGEN_DATETIME; FTextHistory_ArgumentDataFormat never matches.
 */
const COMPLEX_TEXT_MARKERS = [
  "INVTEXT",
  "NSLOCTEXT",
  "LOCTEXT",
  "LOCTABLE",
  "LOCGEN_FORMAT_NAMED",
  "LOCGEN_FORMAT_ORDERED",
  "LOCGEN_NUMBER",
  "LOCGEN_PERCENT",
  "LOCGEN_CURRENCY",
  "LOCGEN_DATE",
  "LOCGEN_TIME",
  "LOCGEN_TOLOWER",
  "LOCGEN_TOUPPER",
] as const;

function isComplexText(s: string): boolean {
  return COMPLEX_TEXT_MARKERS.some((m) => s.startsWith(m));
}

function classifyTagValue(s: string): "ansi" | "wide" | "loc" {
  if (isComplexText(s)) {
    return "loc";
  }
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      return "wide";
    }
  }
  return "ansi";
}

function isPureAnsi(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      return false;
    }
  }
  return true;
}

function writeExportPathWire(
  w: BinaryWriter,
  names: UeNameRegistry,
  ep: AssetRegistryExportPathWire,
): void {
  names.writeFName(w, ep.classPkg);
  names.writeFName(w, ep.classAsset);
  names.writeFName(w, ep.objectName);
  names.writeFName(w, ep.packageName);
}

/**
 * Options aligned with `FAssetRegistrySerializationOptions` / `FixedTagPrivate::FStoreBuilder`
 * (`Engine/Source/Runtime/CoreUObject/Private/AssetRegistry/AssetDataTagMap.cpp`).
 */
export interface FixedTagStoreBuilderOptions {
  /** `FAssetRegistryVersion` from the registry header — drives `FMarshalledText` serialization in the text pool. */
  readonly fileVersion: number;
  /** `CookTagsAsName` — tag keys whose values use `NumberlessName` / `Name` pools (`IndexValue` name branch). */
  readonly cookTagsAsName?: ReadonlySet<string>;
  /** `CookTagsAsPath` — tag keys whose values use export-path pools (`IndexValue` path branch). */
  readonly cookTagsAsPath?: ReadonlySet<string>;
}

/**
 * `FixedTagPrivate::FStoreBuilder` + fixed-tag `Save` layout (`VisitViews` pool order matches `loadFixedTagStore`).
 */
export class FixedTagStoreBuilder {
  private readonly fileVersion: number;
  private readonly cookTagsAsName: ReadonlySet<string>;
  private readonly cookTagsAsPath: ReadonlySet<string>;

  private readonly texts: string[] = [];
  private readonly textIndex = new Map<string, number>();

  private readonly numberlessNameFlat: string[] = [];
  private readonly numberlessNameIndex = new Map<string, number>();

  private readonly nameFlat: FNameWire[] = [];
  private readonly nameIndex = new Map<string, number>();

  private readonly numberlessExportFlat: AssetRegistryExportPathWire[] = [];
  private readonly numberlessExportIndex = new Map<string, number>();

  private readonly exportFlat: AssetRegistryExportPathWire[] = [];
  private readonly exportIndex = new Map<string, number>();

  private readonly ansiFlat = new BinaryWriter();
  private readonly ansiOffsets: number[] = [];
  private readonly ansiIndex = new Map<string, number>();

  private readonly wideFlat = new BinaryWriter();
  private readonly wideOffsets: number[] = [];
  private readonly wideIndex = new Map<string, number>();

  private readonly numberlessPairs: { key: string; valueId: number }[] = [];
  private readonly pairs: { key: FNameWire; valueId: number }[] = [];

  constructor(options: FixedTagStoreBuilderOptions) {
    this.fileVersion = options.fileVersion;
    this.cookTagsAsName = options.cookTagsAsName ?? new Set();
    this.cookTagsAsPath = options.cookTagsAsPath ?? new Set();
  }

  private internNumberlessName(display: string): number {
    let i = this.numberlessNameIndex.get(display);
    if (i !== undefined) {
      return i;
    }
    i = this.numberlessNameFlat.length;
    this.numberlessNameFlat.push(display);
    this.numberlessNameIndex.set(display, i);
    return i;
  }

  private internName(f: FNameWire): number {
    const key = `${f.base}\0${f.number}`;
    let i = this.nameIndex.get(key);
    if (i !== undefined) {
      return i;
    }
    i = this.nameFlat.length;
    this.nameFlat.push(f);
    this.nameIndex.set(key, i);
    return i;
  }

  private internNumberlessExportPath(ep: AssetRegistryExportPathWire): number {
    const key = assetRegistryExportPathDisplay(ep);
    let i = this.numberlessExportIndex.get(key);
    if (i !== undefined) {
      return i;
    }
    i = this.numberlessExportFlat.length;
    this.numberlessExportFlat.push(ep);
    this.numberlessExportIndex.set(key, i);
    return i;
  }

  private internExportPath(ep: AssetRegistryExportPathWire): number {
    const key = assetRegistryExportPathDisplay(ep);
    let i = this.exportIndex.get(key);
    if (i !== undefined) {
      return i;
    }
    i = this.exportFlat.length;
    this.exportFlat.push(ep);
    this.exportIndex.set(key, i);
    return i;
  }

  private internAnsi(s: string): number {
    let i = this.ansiIndex.get(s);
    if (i !== undefined) {
      return i;
    }
    const off = this.ansiFlat.length;
    this.ansiFlat.writeBytes(Buffer.from(s + "\0", "latin1"));
    i = this.ansiOffsets.length;
    this.ansiOffsets.push(off);
    this.ansiIndex.set(s, i);
    return i;
  }

  private internWide(s: string): number {
    let i = this.wideIndex.get(s);
    if (i !== undefined) {
      return i;
    }
    const off = this.wideFlat.length / 2;
    const body = Buffer.from(s, "utf16le");
    this.wideFlat.writeBytes(body);
    this.wideFlat.writeU16(0);
    i = this.wideOffsets.length;
    this.wideOffsets.push(off);
    this.wideIndex.set(s, i);
    return i;
  }

  private internLoc(s: string): number {
    let i = this.textIndex.get(s);
    if (i !== undefined) {
      return i;
    }
    i = this.texts.length;
    this.texts.push(s);
    this.textIndex.set(s, i);
    return i;
  }

  /**
   * `FStoreBuilder::IndexValue`: name/path pools when cook sets contain the key; else marshalled-text / FString branch
   * for localized markers; else `FCString::IsPureAnsi`-style ANSI vs wide (`AssetDataTagMap.cpp`).
   */
  private indexValue(key: string, v: string, preferredType?: TagValueTypeId): number {
    if (preferredType === EValueType.LocalizedText || classifyTagValue(v) === "loc") {
      return makeValueId(EValueType.LocalizedText, this.internLoc(v));
    }
    if (this.cookTagsAsName.has(key)) {
      const f = parseFNameWireFromRegistryTag(v);
      if (f.number === 0) {
        return makeValueId(EValueType.NumberlessName, this.internNumberlessName(f.base));
      }
      return makeValueId(EValueType.Name, this.internName(f));
    }
    if (this.cookTagsAsPath.has(key)) {
      const ep = parseAssetRegistryExportPathFromDisplay(v);
      if (isExportPathWireAllNumberless(ep)) {
        return makeValueId(EValueType.NumberlessExportPath, this.internNumberlessExportPath(ep));
      }
      return makeValueId(EValueType.ExportPath, this.internExportPath(ep));
    }
    if (isPureAnsi(v)) {
      return makeValueId(EValueType.AnsiString, this.internAnsi(v));
    }
    return makeValueId(EValueType.WideString, this.internWide(v));
  }

  /** `FStoreBuilder::AddTagMap` — choose NumberlessPairs vs Pairs per-map from key numberless-ness. */
  addTagMap(tags: Record<string, string>, tagValueTypeHints?: Record<string, TagValueTypeId>): bigint {
    const keys = tagKeysSortedLexical(Object.keys(tags));
    if (keys.length === 0) {
      return 0n;
    }
    const parsedKeys = keys.map((k) => parseFNameWireFromRegistryTag(k));
    const hasNumberlessKeys = parsedKeys.every((k) => k.number === 0);
    const pairBegin = hasNumberlessKeys ? this.numberlessPairs.length : this.pairs.length;
    for (const k of keys) {
      const vid = this.indexValue(k, tags[k]!, tagValueTypeHints?.[k]);
      const fk = parseFNameWireFromRegistryTag(k);
      if (hasNumberlessKeys) {
        this.numberlessPairs.push({ key: fk.base, valueId: vid });
      } else {
        this.pairs.push({ key: fk, valueId: vid });
      }
    }
    return toPartialMapHandle(hasNumberlessKeys, keys.length, pairBegin);
  }

  /**
   * Text pool: `FMarshalledText` uses `FUtf8String` once `Version >= MarshalledTextAsUTF8String`, else `FString`
   * (`TSerializer<LatestVersion>` in `AssetDataTagMap.cpp`; load in `fixedStore.readMarshalledText`).
   */
  serialize(names: UeNameRegistry): Buffer {
    const textBlob = new BinaryWriter();
    for (const t of this.texts) {
      if (this.fileVersion >= MARSHALLED_TEXT_UTF8_ENUM) {
        textBlob.writeUtf8StringNoNul(t);
      } else {
        textBlob.writeFStringUE(t);
      }
    }
    const textBlobBytes = textBlob.toBuffer();
    const ansiBytes = this.ansiFlat.toBuffer();
    const wideBytes = this.wideFlat.toBuffer();

    const w = new BinaryWriter();
    w.writeU32(FIXED_TAG_BEGIN_MAGIC);

    w.writeI32(this.numberlessNameFlat.length);
    w.writeI32(this.nameFlat.length);
    w.writeI32(this.numberlessExportFlat.length);
    w.writeI32(this.exportFlat.length);
    w.writeI32(this.texts.length);
    w.writeI32(this.ansiOffsets.length);
    w.writeI32(this.wideOffsets.length);
    w.writeI32(ansiBytes.length);
    w.writeI32(wideBytes.length / 2);
    w.writeI32(this.numberlessPairs.length);
    w.writeI32(this.pairs.length);

    w.writeU32(textBlobBytes.length >>> 0);
    w.writeBytes(textBlobBytes);

    for (const s of this.numberlessNameFlat) {
      names.writeFName(w, plainFName(s));
    }
    for (const f of this.nameFlat) {
      names.writeFName(w, f);
    }
    for (const ep of this.numberlessExportFlat) {
      writeExportPathWire(w, names, ep);
    }
    for (const ep of this.exportFlat) {
      writeExportPathWire(w, names, ep);
    }

    for (const off of this.ansiOffsets) {
      w.writeU32(off >>> 0);
    }
    for (const off of this.wideOffsets) {
      w.writeU32(off >>> 0);
    }
    w.writeBytes(ansiBytes);
    w.writeBytes(wideBytes);

    for (const pr of this.numberlessPairs) {
      names.writeFName(w, plainFName(pr.key));
      w.writeU32(pr.valueId >>> 0);
    }
    for (const pr of this.pairs) {
      names.writeFName(w, pr.key);
      w.writeU32(pr.valueId >>> 0);
    }

    w.writeU32(FIXED_TAG_END_MAGIC);
    return w.toBuffer();
  }
}
