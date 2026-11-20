import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyJsonToAssetRegistry } from "../dist/index.js";
import { fNameToString, mergeAssetRowsAppendOnly } from "../dist/unreal/index.js";
import { loadRegistryLoose } from "../dist/unreal/registry/loadRegistry.js";
import { parseFNameWireFromRegistryTag } from "../dist/unreal/registry/assetData.js";
import { compareFNameWire } from "../dist/unreal/registry/fnameWire.js";
import { cityHash64 } from "../dist/unreal/hash/cityHash64.js";
import { generateLowerCaseHashForNameBatchEntry } from "../dist/unreal/registry/nameHash.js";
import { loadedAssetDataFromRegistryRow } from "../dist/manifestToRow.js";

const w = (base, number = 0) => ({ base, number });

describe("FName text -> wire (FNameHelper::ParseNumber)", () => {
  it("splits like the engine (UE 5.1 UnrealNames.cpp tests)", () => {
    assert.deepEqual(parseFNameWireFromRegistryTag("Text_0"), w("Text", 1));
    assert.deepEqual(parseFNameWireFromRegistryTag("Text_1_0"), w("Text_1", 1));
    assert.deepEqual(parseFNameWireFromRegistryTag("/Game/Characters/CN_100"), w("/Game/Characters/CN", 101));
    assert.deepEqual(parseFNameWireFromRegistryTag("Used_2147483646"), w("Used", 2147483647));
    for (const whole of ["Text_00", "Text_01", "Used_2147483647", "Used_12345678901", "Text_", "Text", "", "_"]) {
      assert.deepEqual(parseFNameWireFromRegistryTag(whole), w(whole), whole);
    }
  });

  it("round-trips through fNameToString", () => {
    for (const s of ["CN_230", "CP_290_10", "Text_00", "Plain", "X_0"]) {
      assert.equal(fNameToString(parseFNameWireFromRegistryTag(s)), s);
    }
  });

  it("splits package, path and asset names of new rows", () => {
    const a = loadedAssetDataFromRegistryRow(
      { packageName: "/Game/Mod/CP_300/T_Emblem_9001", objectName: "T_Emblem_9001" },
      "test",
    );
    assert.deepEqual(a.packagePath, w("/Game/Mod/CP", 301));
    assert.deepEqual(a.packageName, w("/Game/Mod/CP_300/T_Emblem", 9002));
    assert.deepEqual(a.assetName, w("T_Emblem", 9002));
  });
});

describe("FName ordering (FName::Compare)", () => {
  it("compares different bases by base string only", () => {
    // ("SK_CN_050", 11) displays as "SK_CN_050_10" but sorts before "SK_CN_050_00".
    assert.ok(compareFNameWire(w("/M/SK_CN_050", 11), w("/M/SK_CN_050_00")) < 0);
    assert.ok(compareFNameWire(w("abc", 99), w("abd", 1)) < 0);
  });

  it("is case-insensitive and breaks ties on the number", () => {
    assert.equal(compareFNameWire(w("Foo"), w("fOO")), 0);
    assert.ok(compareFNameWire(w("Foo", 2), w("foo", 3)) < 0);
    // '_' (0x5F) sorts before lowercased letters, as with UE's ASCII ToLower.
    assert.ok(compareFNameWire(w("A_B"), w("Aa")) < 0);
  });
});

describe("CityHash64 / name batch hashes", () => {
  it("matches the reference empty-input value", () => {
    assert.equal(cityHash64(Buffer.alloc(0)), 0x9ae16a3b2f90404fn);
  });

  it("matches hashes stored by the engine for every length class", () => {
    // Values copied from the stock JJK CC AssetRegistry.bin name batch.
    const vectors = [
      ["Pi", 0xb40b96d762141645n],
      ["M_Manip", 0x137f541492c5cc29n],
      ["/Script/Engine", 0xed817b8ae25383a8n],
      ["/ControlRig/Controls", 0x9ecfcaab78885094n],
      ["/ControlRig/Controls/ControlRig_Arrow2_1mm", 0xee01feff85bb52edn],
      ["/Engine/Functions/Engine_MaterialFunctions01/Chromakeying/RGBtoHSV", 0x2b1762c4431663ccn],
    ];
    for (const [s, h] of vectors) {
      assert.equal(generateLowerCaseHashForNameBatchEntry(s, false), h, s);
    }
  });

  it("matches UE's compiled GenerateLowerCaseHash for long and non-ASCII names", () => {
    // Expected values from UE 5.1 Core/Private/Hash/CityHash.cpp compiled with MSVC, fed
    // through GenerateLowerCaseHash (UnrealNames.cpp:858) + TChar::ToLower (Char.h:89).
    // The stock registry has no names over 128 bytes (2+ chunk-loop iterations) or
    // wide (UTF-16) names, so these cover what the stock vectors cannot.
    const ansi = [
      [
        "/Game/Mods/SomeAuthor/Characters/CP_300/Materials/Instances/Outfits/Casual/MI_CP_300_Casual_Body_Variant_Red_Outline_Final",
        0x025dd1f906d69a62n,
      ],
      ["/Game/" + "Folder_Name/".repeat(20) + "T_Asset", 0x64a6bf7af1b1d621n], // 253 bytes
      ["Abc_".repeat(256), 0xe654e3c0f48156a5n], // 1024 bytes, UE's max name length
    ];
    const wide = [
      ["呪術廻戦", 0x3995e2c22b117f17n],
      ["/Game/Mods/虎杖悠仁/Émblème_Ü", 0xb48aa5a85a1af277n],
      ["/Game/Mods/" + "呪術廻戦_😀_Ａ".repeat(12), 0x905c8780bd31780bn], // 238 bytes, surrogate pairs
    ];
    for (const [s, h] of ansi) assert.equal(generateLowerCaseHashForNameBatchEntry(s, false), h, s);
    for (const [s, h] of wide) assert.equal(generateLowerCaseHashForNameBatchEntry(s, true), h, s);
  });
});

const stockPath = fileURLToPath(new URL("../../data/AssetRegistry.bin", import.meta.url));
const haveStock = existsSync(stockPath);
const skip = !haveStock && "stock AssetRegistry.bin not available";

describe("stock registry", { skip }, () => {
  const stock = haveStock ? readFileSync(stockPath) : Buffer.alloc(0);

  it("empty merge is byte-identical to stock", () => {
    const out = applyJsonToAssetRegistry(stock, []);
    // Name batch header: HashVersion at 32..40 must be FNameHash::AlgorithmId, so the
    // engine trusts the saved hashes — which are therefore covered by this comparison.
    assert.equal(out.readBigUInt64LE(32), 0xc1640000n);
    assert.equal(out.length, stock.length);
    let first = -1;
    for (let i = 0; i < stock.length && first < 0; i++) if (out[i] !== stock[i]) first = i;
    assert.equal(first, -1, `first differing byte at offset ${first}`);
  });

  it("stores no splittable name whole", () => {
    const reg = loadRegistryLoose(stock);
    const re = /^(.+)_(0|[1-9]\d{0,9})$/;
    for (const a of reg.assets) {
      for (const f of [a.packagePath, a.packageName, a.assetName]) {
        if (f.number === 0) assert.doesNotMatch(f.base, re);
      }
    }
  });

  it("appends a numbered row in split form", () => {
    const row = { packageName: "/Game/ZZTest/CP_300/T_Emblem_9001", objectName: "T_Emblem_9001" };
    const reg = loadRegistryLoose(applyJsonToAssetRegistry(stock, [row]));
    const added = reg.assets.filter((a) => fNameToString(a.packageName) === row.packageName);
    assert.equal(added.length, 1);
    assert.deepEqual(added[0].packagePath, w("/Game/ZZTest/CP", 301));
    assert.deepEqual(added[0].assetName, w("T_Emblem", 9002));
  });

  it("skips a row that differs from a stock asset only by case", () => {
    const reg = loadRegistryLoose(stock);
    const first = reg.assets.find((a) => a.packageName.base.startsWith("/Game/"));
    const row = {
      packageName: fNameToString(first.packageName).toUpperCase(),
      objectName: fNameToString(first.assetName).toLowerCase(),
    };
    const out = loadRegistryLoose(applyJsonToAssetRegistry(stock, [row]));
    assert.equal(out.assets.length, reg.assets.length);
  });

  it("rejects case-variant collisions in append-only merges", () => {
    const reg = loadRegistryLoose(stock);
    const first = reg.assets[0];
    const dup = { ...first, packageName: w(first.packageName.base.toLowerCase(), first.packageName.number) };
    assert.throws(() => mergeAssetRowsAppendOnly(reg.assets, [dup]), /collision/);
  });
});
