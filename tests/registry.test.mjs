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
import { assertRegistryRows, loadedAssetDataFromRegistryRow } from "../dist/manifestToRow.js";
import {
  buildEmptyAssetRegistryBin,
  saveRegistryWithStagedAssets,
  serializeRegistryState,
} from "../dist/unreal/registry/saveRegistry.js";
import {
  parseAssetRegistryExportPathFromDisplay,
  softObjectPathWireDisplay,
  softObjectPathWireFromDisplayString,
  topLevelPathWiresFromString,
  classPathWiresFromString,
} from "../dist/unreal/registry/assetData.js";
import { sortedImportedClasses } from "../dist/unreal/registry/ueSerializeRegistry.js";
import { UeNameRegistry } from "../dist/unreal/registry/ueNameRegistry.js";
import { loadNameBatch } from "../dist/unreal/registry/nameBatch.js";
import { BinaryReader } from "../dist/unreal/io/binaryReader.js";
import { BinaryWriter } from "../dist/unreal/io/binaryWriter.js";
import { FixedTagStoreBuilder } from "../dist/unreal/registry/fixedTagStoreBuilder.js";
import { defaultPackageDataV16, packageDataV16FromCookedAssetFile } from "../dist/unreal/registry/packageDataRw.js";
import { assetIdentityKey } from "../dist/unreal/registry/identity.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const w = (base, number = 0) => ({ base, number });

describe("FName text -> wire (FNameHelper::ParseNumber)", () => {
  it("splits like the engine (UE 5.1 UnrealNames.cpp tests)", () => {
    assert.deepEqual(parseFNameWireFromRegistryTag("Text_0"), w("Text", 1));
    assert.deepEqual(parseFNameWireFromRegistryTag("Text_1_0"), w("Text_1", 1));
    assert.deepEqual(parseFNameWireFromRegistryTag("/Game/Characters/CN_100"), w("/Game/Characters/CN", 101));
    assert.deepEqual(parseFNameWireFromRegistryTag("Used_2147483646"), w("Used", 2147483647));
    for (const whole of ["Text_00", "Text_01", "Used_2147483647", "Used_12345678901", "Text_", "Text", "_", "_01"]) {
      assert.deepEqual(parseFNameWireFromRegistryTag(whole), w(whole), whole);
    }
  });

  it("maps empty names and bare _<number> to NAME_None (MakeWithNumber with Len 0)", () => {
    for (const none of ["", "_0", "_1", "_123"]) {
      assert.deepEqual(parseFNameWireFromRegistryTag(none), w("None"), none);
    }
  });

  it("round-trips through fNameToString", () => {
    for (const s of ["CN_230", "CP_290_10", "Text_00", "Plain", "X_0"]) {
      assert.equal(fNameToString(parseFNameWireFromRegistryTag(s)), s);
    }
  });

  it("splits package, path and asset names of new rows", () => {
    const a = loadedAssetDataFromRegistryRow(
      { packageName: "/Game/Mod/CP_300/T_Emblem_9001", objectName: "T_Emblem_9001", classPath: "/Script/Engine.Texture2D" },
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

describe("name batch (FArchive SaveNameBatch / LoadNameBatch)", () => {
  it("stores wide names contiguously, without UTF-16 alignment padding", () => {
    const list = ["A", "T_呪術", "B", "T_é", "xyz"];
    const names = new UeNameRegistry();
    const sink = new BinaryWriter();
    for (const s of list) names.writeFName(sink, w(s));
    const out = new BinaryWriter();
    names.appendNameBatchTo(out);
    const buf = out.toBuffer();
    const unpadded = list.reduce((n, s) => n + (/[^\x00-\x7f]/.test(s) ? s.length * 2 : s.length), 0);
    assert.equal(buf.readUInt32LE(4), unpadded); // NumStringBytes
    assert.equal(buf.length, 4 + 4 + 8 + list.length * (8 + 2) + unpadded);
    assert.deepEqual(loadNameBatch(new BinaryReader(buf)).entries, list);
  });

  it("writes an empty name as None and rejects names of NAME_SIZE or more", () => {
    const names = new UeNameRegistry();
    names.writeFName(new BinaryWriter(), w("", 5));
    assert.deepEqual(names.getDisplayEntriesInOrder(), ["None"]);
    const ok = new UeNameRegistry();
    ok.writeFName(new BinaryWriter(), w("x".repeat(1023)));
    ok.appendNameBatchTo(new BinaryWriter());
    const long = new UeNameRegistry();
    long.writeFName(new BinaryWriter(), w("x".repeat(1024)));
    assert.throws(() => long.appendNameBatchTo(new BinaryWriter()), /too long/);
  });
});

describe("paths (FTopLevelAssetPath / FSoftObjectPath / ParseExportPath)", () => {
  it("splits top-level paths on the first dot and rejects sub-object paths", () => {
    assert.deepEqual(topLevelPathWiresFromString("/Script/Engine.Texture2D"), {
      pkg: w("/Script/Engine"),
      asset: w("Texture2D"),
    });
    assert.deepEqual(topLevelPathWiresFromString("/Game/Pkg"), { pkg: w("/Game/Pkg"), asset: w("None") });
    assert.throws(() => topLevelPathWiresFromString("/Game/A.B.C"), /sub-object/);
    assert.throws(() => topLevelPathWiresFromString("/Game/A.B:C"), /sub-object/);
  });

  it("rejects short names in top-level paths (TrySetPath ensure + Reset)", () => {
    assert.throws(() => topLevelPathWiresFromString("Texture2D"), /short names/);
    assert.deepEqual(topLevelPathWiresFromString(""), { pkg: w("None"), asset: w("None") });
  });

  it("accepts only full /Package.Class paths as class paths", () => {
    assert.deepEqual(classPathWiresFromString("/Script/Engine.Texture2D"), {
      pkg: w("/Script/Engine"),
      asset: w("Texture2D"),
    });
    assert.deepEqual(classPathWiresFromString("/Game/BP/BP_Foo.BP_Foo_C").asset, w("BP_Foo_C"));
    for (const bad of [
      "Texture2D",
      "Engine.Texture2D",
      "/Script/Engine",
      "/Script/Engine.A.B",
      "/Script/Engine.A:B",
      "/Script/Engine.",
      "/.Texture2D",
      "/Script/.Texture2D",
      "/Script/Engine.None",
      "None",
    ]) {
      assert.throws(() => classPathWiresFromString(bad, "row[3]"), /row\[3\]: classPath .*\/Script\/Engine\.Texture2D/, bad);
    }
  });

  it("splits soft object paths like FSoftObjectPath::SetPath", () => {
    const p = softObjectPathWireFromDisplayString("/Game/A.B.C:D");
    assert.deepEqual([p.packagePart, p.assetPart, p.subUtf8], [w("/Game/A"), w("B"), "C.D"]);
    const q = softObjectPathWireFromDisplayString("/Game/A.B:C");
    assert.deepEqual([q.packagePart, q.assetPart, q.subUtf8], [w("/Game/A"), w("B"), "C"]);
    const r = softObjectPathWireFromDisplayString("/Game/A");
    assert.deepEqual([r.packagePart, r.assetPart, r.subUtf8], [w("/Game/A"), w("None"), ""]);
  });

  it("parses export paths like ParseExportPath", () => {
    assert.deepEqual(parseAssetRegistryExportPathFromDisplay("/Game/Mod/BP.BP_C"), {
      classPkg: w("None"),
      classAsset: w("None"),
      packageName: w("/Game/Mod/BP"),
      objectName: w("BP_C"),
    });
    assert.deepEqual(parseAssetRegistryExportPathFromDisplay("/Script/Engine.Blueprint'/Game/A.B:C'"), {
      classPkg: w("/Script/Engine"),
      classAsset: w("Blueprint"),
      packageName: w("/Game/A"),
      objectName: w("B:C"),
    });
    assert.deepEqual(parseAssetRegistryExportPathFromDisplay("/Game/Pkg").objectName, w("None"));
  });
});

describe("synthetic registry round-trips", () => {
  const header = loadRegistryLoose(buildEmptyAssetRegistryBin()).header;
  const row = (packageName, objectName, extra = {}) =>
    loadedAssetDataFromRegistryRow({ packageName, objectName, classPath: "/Script/Engine.Texture2D", ...extra }, "t");
  const cooked = Buffer.alloc(16, 0xab);
  const pkgData = {
    ...defaultPackageDataV16(""),
    cookedValid: true,
    cookedBytes: cooked,
    importedClasses: [w("Texture2D")],
  };
  const dep = {
    nodes: [
      {
        identifier: { packageName: w("/Game/Dep/A") },
        packageDependencies: [1],
        packageFlagWords: [0x1f],
        nameDependencies: [],
        // 33 manage deps × 1 bit (ManageFlagSetWidth) = 2 words.
        manageDependencies: Array.from({ length: 33 }, () => 1),
        manageFlagWords: [0xffffffff, 1],
        referencers: [],
      },
      {
        identifier: {
          packageName: w("/Game/Dep/B"),
          primaryAssetType: w("PrimType"),
          objectName: w("Obj", 3),
          valueName: w("Val"),
        },
        packageDependencies: [],
        packageFlagWords: [],
        nameDependencies: [0],
        manageDependencies: [],
        manageFlagWords: [],
        referencers: [0],
      },
    ],
  };
  const base = serializeRegistryState(header, [row("/Game/Dep/A", "A")], dep, [
    { name: w("/Game/Dep/A"), data: pkgData },
  ]);

  it("re-interns dependency names and keeps package data through a merge", () => {
    // The new row's names are interned first, shifting every name index of the base file.
    const merged = applyJsonToAssetRegistry(base, [{ packageName: "/Game/AAA/First", objectName: "First", classPath: "/Script/Engine.Texture2D" }]);
    const reg = loadRegistryLoose(merged);
    assert.equal(reg.nameTable.entries[0], "/Game/AAA");
    assert.deepEqual(reg.dependencyData, dep);
    assert.equal(reg.packages.length, 1);
    assert.deepEqual(reg.packages[0].data.cookedBytes, cooked);
    assert.deepEqual(reg.packages[0].data.importedClasses, [w("Texture2D")]);
    // FMD5Hash::bIsValid is a 4-byte UBOOL followed by the 16 hash bytes.
    assert.ok(merged.indexOf(Buffer.concat([Buffer.from([1, 0, 0, 0]), cooked])) > 0);
  });

  it("sorts ImportedClasses with FNameLexicalLess on save, like SerializeForCacheInternal", () => {
    const sorted = [
      w("/Script/Engine.AnimSequence"),
      w("/script/engine.Texture2D"),
      // FName::Compare: base first, then number, so SK_CN_050_10 (base SK_CN_050, 11) < SK_CN_050_00.
      w("/Script/X.SK_CN_050", 11),
      w("/Script/X.SK_CN_050_00"),
      w("/Script/X.SK_CN_050_00", 2),
    ];
    const unsorted = [sorted[3], sorted[1], sorted[4], sorted[0], sorted[2]];
    const build = (classes) =>
      serializeRegistryState(header, [row("/Game/Imp/A", "A")], { nodes: [] }, [
        { name: w("/Game/Imp/A"), data: { ...pkgData, importedClasses: classes } },
      ]);
    const fromUnsorted = build(unsorted);
    const reg = loadRegistryLoose(fromUnsorted);
    assert.deepEqual(reg.packages[0].data.importedClasses, sorted);
    // Same bytes (incl. name-batch order) as writing the sorted array; re-saving is a no-op.
    assert.ok(fromUnsorted.equals(build(sorted)));
    assert.ok(serializeRegistryState(reg.header, reg.assets, reg.dependencyData, reg.packages).equals(fromUnsorted));
    // Input array is not mutated; an already-sorted array (incl. Compare-equal names) is kept as-is.
    assert.equal(unsorted[0], sorted[3]);
    const ties = [w("/Script/A.b"), w("/Script/A.B")];
    assert.equal(sortedImportedClasses(ties), ties);
    // A merge re-sorts package rows it rebuilds from an unsorted base.
    const merged = loadRegistryLoose(applyJsonToAssetRegistry(fromUnsorted, []));
    assert.deepEqual(merged.packages[0].data.importedClasses, sorted);
  });

  it("keeps package data in saveRegistryWithStagedAssets", () => {
    const reg = loadRegistryLoose(saveRegistryWithStagedAssets(loadRegistryLoose(base), [row("/Game/New/N", "N")]));
    const names = reg.packages.map((p) => fNameToString(p.name)).sort();
    assert.deepEqual(names, ["/Game/Dep/A", "/Game/New/N"]);
    assert.deepEqual(reg.packages.find((p) => p.name.base === "/Game/Dep/A").data.cookedBytes, cooked);
  });

  it("round-trips bundle sub-paths as FStrings, including non-ASCII", () => {
    const a = row("/Game/B/X", "X", {});
    a.bundles = [
      { bundleName: w("Game"), paths: ["/Game/B/Y.Y", "/Game/B/Z.Z:Sub_é"].map(softObjectPathWireFromDisplayString) },
    ];
    const out = serializeRegistryState(header, [a], { nodes: [] }, []);
    const reg = loadRegistryLoose(out);
    assert.deepEqual(reg.assets[0].bundles[0].paths.map(softObjectPathWireDisplay), ["/Game/B/Y.Y", "/Game/B/Z.Z:Sub_é"]);
    // Empty sub-path is SaveNum 0; "Sub_é" is SaveNum -6 followed by UTF-16 incl. NUL.
    assert.ok(out.indexOf(Buffer.concat([Buffer.from([0xfa, 0xff, 0xff, 0xff]), Buffer.from("Sub_é\0", "utf16le")])) > 0);
  });

  it("stores empty names and unquoted export paths like the engine", () => {
    const a = row("NoSlash", "NoSlash", {
      tags: { PathTag: "/Game/Mod/BP.BP_C", NameTag: "", PkgOnly: "/Game/Mod/Pkg" },
    });
    assert.deepEqual(a.packagePath, w("None"));
    const out = serializeRegistryState(header, [a], { nodes: [] }, [], {
      cookTagsAsName: new Set(["NameTag"]),
      cookTagsAsPath: new Set(["PathTag", "PkgOnly"]),
    });
    const reg = loadRegistryLoose(out);
    assert.ok(!reg.nameTable.entries.includes(""));
    assert.deepEqual(reg.assets[0].tags, { NameTag: "None", PathTag: "/Game/Mod/BP.BP_C", PkgOnly: "/Game/Mod/Pkg" });
    assert.deepEqual(reg.store.numberlessExportPaths.sort(), ["/Game/Mod/BP.BP_C", "/Game/Mod/Pkg"]);
  });

  it("detects complex text by IsComplexText marker prefix and sorts keys by FName::Compare", () => {
    const tags = {
      abc_0a: "1",
      abc_10: "2",
      T1: 'LOCTABLE("/Game/ST", "Key")',
      T2: 'LOCGEN_NUMBER(1, "")',
      T3: ' NSLOCTEXT("a", "b", "c")',
    };
    const out = serializeRegistryState(header, [row("/Game/T/T", "T", { tags })], { nodes: [] }, []);
    const reg = loadRegistryLoose(out);
    assert.deepEqual(reg.store.texts.sort(), [tags.T2, tags.T1].sort());
    // ("abc", 11) sorts before "abc_0a": different bases compare by base only.
    assert.deepEqual(Object.keys(reg.assets[0].tags), ["abc_10", "abc_0a", "T1", "T2", "T3"]);
  });

  it("defaults packageFlags to the cooked package flags", () => {
    assert.equal(row("/Game/F/F", "F").packageFlags, 0x80002200);
  });

  it("throws on more than 65535 tags in one map", () => {
    const b = new FixedTagStoreBuilder({ fileVersion: header.version });
    const many = {};
    for (let i = 0; i < 65536; i++) many[`K${i}x`] = "v";
    assert.throws(() => b.addTagMap(many), /65535/);
  });
});

describe("manifest rows", () => {
  it("requires classPath", () => {
    const base = { packageName: "/Game/Mods/X/T_A", objectName: "T_A" };
    assert.throws(() => assertRegistryRows([base], "m"), /m\[0\]\.classPath/);
    assert.throws(() => assertRegistryRows([{ ...base, classPath: "  " }], "m"), /classPath/);
    assert.throws(() => loadedAssetDataFromRegistryRow(base, "r"), /classPath is required/);
    const [row] = assertRegistryRows([{ ...base, classPath: " /Script/Engine.Texture2D " }], "m");
    assert.equal(row.classPath, "/Script/Engine.Texture2D");
  });

  it("rejects short and malformed classPath values, naming the row", () => {
    const base = { packageName: "/Game/Mods/X/T_A", objectName: "T_A" };
    for (const classPath of ["Texture2D", "/Script/Engine", "/Script/Engine.A.B"]) {
      assert.throws(
        () => assertRegistryRows([base, { ...base, classPath }], "m"),
        (e) => /m\[0\]/.test(e.message) && e.message.includes("/Script/Engine.Texture2D"),
      );
      assert.throws(
        () => loadedAssetDataFromRegistryRow({ ...base, classPath }, "rowX"),
        (e) => e.message.startsWith("rowX:") && e.message.includes("/Script/Engine.Texture2D"),
      );
      assert.throws(() => applyJsonToAssetRegistry(buildEmptyAssetRegistryBin(), [{ ...base, classPath }]), /classPath/);
    }
  });
});

describe("misc engine rules", () => {
  it("folds case ASCII-only for identity", () => {
    assert.equal(assetIdentityKey("/Game/Foo", "Bar"), assetIdentityKey("/game/FOO", "bar"));
    assert.notEqual(assetIdentityKey("/Game/É", "x"), assetIdentityKey("/Game/é", "x"));
  });

  it("recognizes PACKAGE_FILE_TAG when reading a package summary", () => {
    const sw = new BinaryWriter();
    sw.writeU32(0x9e2a83c1);
    sw.writeI32(-8); // LegacyFileVersion
    sw.writeI32(0); // LegacyUE3Version
    sw.writeI32(522);
    sw.writeI32(1004);
    sw.writeI32(0);
    sw.writeBytes(Buffer.alloc(20, 7)); // SavedHash
    sw.writeI32(100); // TotalHeaderSize
    sw.writeI32(0); // CustomVersions
    sw.writeFStringUE("/Game/P");
    sw.writeU32(0x80002200);
    const f = join(mkdtempSync(join(tmpdir(), "arp-")), "P.uasset");
    writeFileSync(f, sw.toBuffer());
    const d = packageDataV16FromCookedAssetFile(f, "/Game/P");
    assert.equal(d.flags, 0x80002200);
    assert.equal(d.fileVersionUE4, 522);
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
    const row = { packageName: "/Game/ZZTest/CP_300/T_Emblem_9001", objectName: "T_Emblem_9001", classPath: "/Script/Engine.Texture2D" };
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
      classPath: "/Script/Engine.Texture2D",
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
