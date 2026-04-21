import { writeFileSync } from "node:fs";
import type { AssetBundleEntry, LoadedAssetData } from "./assetData.js";
import { softObjectPathWireDisplay } from "./assetData.js";
import { fNameToString, type FNameWire } from "./fnameWire.js";
import { assetIdentityKey } from "./identity.js";
import { loadRegistryLoose, type LoadedRegistry } from "./loadRegistry.js";
import type { LoadedPackageDataV16 } from "./packageDataRw.js";
import { inferCookTagOptionsFromRegistry, serializeRegistryState } from "./saveRegistry.js";
import type { DependencySectionWire, DependsNodeWire } from "./dependencyRw.js";

function sortedTagJson(tags: Record<string, string>): string {
  const keys = Object.keys(tags).sort();
  return JSON.stringify(keys.map((k) => [k, tags[k]]));
}

function fNameWireEq(a: FNameWire, b: FNameWire): boolean {
  return a.base === b.base && a.number === b.number;
}

function bundlesEqual(a: AssetBundleEntry[], b: AssetBundleEntry[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (!fNameWireEq(x.bundleName, y.bundleName) || x.paths.length !== y.paths.length) {
      return false;
    }
    for (let j = 0; j < x.paths.length; j++) {
      const ps = softObjectPathWireDisplay(x.paths[j]!);
      const pt = softObjectPathWireDisplay(y.paths[j]!);
      if (ps !== pt) {
        return false;
      }
    }
  }
  return true;
}

function assetsEqual(a: LoadedAssetData, b: LoadedAssetData, index: number, issues: string[]): void {
  const p = `assets[${index}]`;
  if (!fNameWireEq(a.packagePath, b.packagePath)) {
    issues.push(`${p}.packagePath`);
  }
  if (!fNameWireEq(a.assetClassPathPackage, b.assetClassPathPackage)) {
    issues.push(`${p}.assetClassPathPackage`);
  }
  if (!fNameWireEq(a.assetClassPathAsset, b.assetClassPathAsset)) {
    issues.push(`${p}.assetClassPathAsset`);
  }
  if (!fNameWireEq(a.packageName, b.packageName)) {
    issues.push(`${p}.packageName`);
  }
  if (!fNameWireEq(a.assetName, b.assetName)) {
    issues.push(`${p}.assetName`);
  }
  if (sortedTagJson(a.tags) !== sortedTagJson(b.tags)) {
    issues.push(`${p}.tags`);
  }
  if (!bundlesEqual(a.bundles, b.bundles)) {
    issues.push(`${p}.bundles`);
  }
  if (a.chunkIds.length !== b.chunkIds.length) {
    issues.push(`${p}.chunkIds.length`);
  } else {
    const as = [...a.chunkIds].sort((x, y) => x - y);
    const bs = [...b.chunkIds].sort((x, y) => x - y);
    for (let i = 0; i < as.length; i++) {
      if (as[i] !== bs[i]) {
        issues.push(`${p}.chunkIds`);
        break;
      }
    }
  }
  if ((a.packageFlags >>> 0) !== (b.packageFlags >>> 0)) {
    issues.push(`${p}.packageFlags`);
  }
}

function bufEq(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

function packageDataEqual(a: LoadedPackageDataV16, b: LoadedPackageDataV16): boolean {
  if (a.diskSize !== b.diskSize || !bufEq(a.legacyGuid, b.legacyGuid) || a.cookedValid !== b.cookedValid) {
    return false;
  }
  if (a.cookedValid) {
    if (!a.cookedBytes || !b.cookedBytes || !bufEq(a.cookedBytes, b.cookedBytes)) {
      return false;
    }
  } else if (b.cookedBytes !== undefined) {
    return false;
  }
  if (a.chunkPairs.length !== b.chunkPairs.length) {
    return false;
  }
  for (let i = 0; i < a.chunkPairs.length; i++) {
    const x = a.chunkPairs[i]!;
    const y = b.chunkPairs[i]!;
    if (!bufEq(x.chunkId, y.chunkId) || !bufEq(x.hash, y.hash)) {
      return false;
    }
  }
  if (
    a.fileVersionUE4 !== b.fileVersionUE4 ||
    a.fileVersionUE5 !== b.fileVersionUE5 ||
    a.fileVersionLicenseeUE !== b.fileVersionLicenseeUE ||
    (a.flags >>> 0) !== (b.flags >>> 0)
  ) {
    return false;
  }
  if (a.customVersions.length !== b.customVersions.length) {
    return false;
  }
  for (let i = 0; i < a.customVersions.length; i++) {
    const x = a.customVersions[i]!;
    const y = b.customVersions[i]!;
    if (!bufEq(x.guid, y.guid) || x.version !== y.version) {
      return false;
    }
  }
  if (a.importedClasses.length !== b.importedClasses.length) {
    return false;
  }
  for (let i = 0; i < a.importedClasses.length; i++) {
    if (!fNameWireEq(a.importedClasses[i]!, b.importedClasses[i]!)) {
      return false;
    }
  }
  return true;
}

function compareRegistries(original: LoadedRegistry, round: LoadedRegistry): string[] {
  const issues: string[] = [];
  if (original.header.version !== round.header.version) {
    issues.push("header.version");
  }
  if (original.header.bFilterEditorOnlyData !== round.header.bFilterEditorOnlyData) {
    issues.push("header.bFilterEditorOnlyData");
  }
  const depIssues = compareDependencySections(original.dependencyData, round.dependencyData);
  for (const x of depIssues) {
    issues.push(`dependency.${x}`);
  }

  if (original.assets.length !== round.assets.length) {
    issues.push(`asset count (${original.assets.length} vs ${round.assets.length})`);
  } else {
    const byKey = new Map<string, LoadedAssetData>();
    for (const a of original.assets) {
      byKey.set(assetIdentityKey(fNameToString(a.packageName), fNameToString(a.assetName)), a);
    }
    for (let i = 0; i < round.assets.length; i++) {
      const ra = round.assets[i]!;
      const k = assetIdentityKey(fNameToString(ra.packageName), fNameToString(ra.assetName));
      const oa = byKey.get(k);
      if (!oa) {
        issues.push(`assets[${i}] missing key in original`);
        continue;
      }
      assetsEqual(oa, ra, i, issues);
    }
  }

  if (original.packages.length !== round.packages.length) {
    issues.push(`package count (${original.packages.length} vs ${round.packages.length})`);
  } else {
    const byName = new Map<string, (typeof original.packages)[0]>();
    for (const p of original.packages) {
      byName.set(fNameToString(p.name), p);
    }
    for (let i = 0; i < round.packages.length; i++) {
      const rp = round.packages[i]!;
      const op = byName.get(fNameToString(rp.name));
      if (!op) {
        issues.push(`packages[${i}] missing in original`);
        continue;
      }
      if (!packageDataEqual(op.data, rp.data)) {
        issues.push(`packages[${i}].data`);
      }
    }
  }
  return issues;
}

function fNameWireOrNoneString(f?: FNameWire): string {
  return f ? `${f.base}\0${f.number}` : "";
}

function identifierKey(n: DependsNodeWire["identifier"]): string {
  return [
    fNameWireOrNoneString(n.packageName),
    fNameWireOrNoneString(n.primaryAssetType),
    fNameWireOrNoneString(n.objectName),
    fNameWireOrNoneString(n.valueName),
  ].join("|");
}

function arrEq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if ((a[i]! | 0) !== (b[i]! | 0)) {
      return false;
    }
  }
  return true;
}

function compareDependencySections(a: DependencySectionWire, b: DependencySectionWire): string[] {
  const issues: string[] = [];
  if (a.nodes.length !== b.nodes.length) {
    issues.push(`nodeCount(${a.nodes.length} vs ${b.nodes.length})`);
    return issues;
  }
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i]!;
    const y = b.nodes[i]!;
    const p = `nodes[${i}]`;
    if (identifierKey(x.identifier) !== identifierKey(y.identifier)) {
      issues.push(`${p}.identifier`);
    }
    if (!arrEq(x.packageDependencies, y.packageDependencies)) {
      issues.push(`${p}.packageDependencies`);
    }
    if (!arrEq(x.packageFlagWords, y.packageFlagWords)) {
      issues.push(`${p}.packageFlagWords`);
    }
    if (!arrEq(x.nameDependencies, y.nameDependencies)) {
      issues.push(`${p}.nameDependencies`);
    }
    if (!arrEq(x.manageDependencies, y.manageDependencies)) {
      issues.push(`${p}.manageDependencies`);
    }
    if (!arrEq(x.manageFlagWords, y.manageFlagWords)) {
      issues.push(`${p}.manageFlagWords`);
    }
    if (!arrEq(x.referencers, y.referencers)) {
      issues.push(`${p}.referencers`);
    }
    if (issues.length > MAX_MISMATCHES) {
      break;
    }
  }
  return issues;
}

export interface RoundTripResult {
  /** True when parsed logical content matches after load→save→load. */
  ok: boolean;
  bytesIdentical: boolean;
  semanticOk: boolean;
  wireOk?: boolean;
  strictWire?: boolean;
  inputBytes: number;
  outputBytes: number;
  mismatchCount: number;
  mismatches: string[];
  wireMismatchCount?: number;
  wireMismatches?: string[];
  regressionChecks?: {
    passed: boolean;
    failures: string[];
  };
  outputPath?: string;
}

const MAX_MISMATCHES = 40;

function compareStringArray(a: string[], b: string[], label: string, out: string[]): void {
  if (a.length !== b.length) {
    out.push(`${label}.length(${a.length} vs ${b.length})`);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      out.push(`${label}[${i}]`);
      return;
    }
  }
}

function compareNumberArray(a: number[], b: number[], label: string, out: string[]): void {
  if (a.length !== b.length) {
    out.push(`${label}.length(${a.length} vs ${b.length})`);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if ((a[i]! | 0) !== (b[i]! | 0)) {
      out.push(`${label}[${i}]`);
      return;
    }
  }
}

function compareFixedStoreWire(original: LoadedRegistry, round: LoadedRegistry): string[] {
  const issues: string[] = [];
  compareStringArray(original.store.texts, round.store.texts, "store.texts", issues);
  compareStringArray(original.store.numberlessNames, round.store.numberlessNames, "store.numberlessNames", issues);
  compareStringArray(original.store.names, round.store.names, "store.names", issues);
  compareStringArray(
    original.store.numberlessExportPaths,
    round.store.numberlessExportPaths,
    "store.numberlessExportPaths",
    issues,
  );
  compareStringArray(original.store.exportPaths, round.store.exportPaths, "store.exportPaths", issues);
  compareStringArray(
    original.store.numberlessPairKeys,
    round.store.numberlessPairKeys,
    "store.numberlessPairKeys",
    issues,
  );
  compareNumberArray(
    original.store.numberlessPairValueIds,
    round.store.numberlessPairValueIds,
    "store.numberlessPairValueIds",
    issues,
  );
  compareStringArray(original.store.pairKeys, round.store.pairKeys, "store.pairKeys", issues);
  compareNumberArray(original.store.pairValueIds, round.store.pairValueIds, "store.pairValueIds", issues);
  compareNumberArray(original.store._ansiOffsets, round.store._ansiOffsets, "store.ansiOffsets", issues);
  compareNumberArray(original.store._wideOffsets, round.store._wideOffsets, "store.wideOffsets", issues);
  if (!original.store._ansiStrings.equals(round.store._ansiStrings)) {
    issues.push("store.ansiStrings");
  }
  if (!original.store._wideStrings.equals(round.store._wideStrings)) {
    issues.push("store.wideStrings");
  }
  return issues;
}

function compareWire(original: LoadedRegistry, round: LoadedRegistry): string[] {
  const issues: string[] = [];
  compareStringArray(original.nameTable.entries, round.nameTable.entries, "nameBatch.entries", issues);
  const aHash = original.nameTable.hashVersion ?? 0n;
  const bHash = round.nameTable.hashVersion ?? 0n;
  if (aHash !== bHash) {
    issues.push(`nameBatch.hashVersion(${aHash} vs ${bHash})`);
  }
  issues.push(...compareFixedStoreWire(original, round));
  if (!original.dependencySection.equals(round.dependencySection)) {
    issues.push("dependencySection.bytes");
  }
  return issues;
}

/**
 * Load → serialize (UE layout) → load, then compare logical content to the original parse.
 */
export function verifyRegistryRoundTrip(
  input: Buffer,
  options?: { writeToPath?: string; verbatim?: boolean; strictWire?: boolean },
): RoundTripResult {
  const reg = loadRegistryLoose(input, {
    keepSourceBuffer: Boolean(options?.verbatim && options?.writeToPath),
  });
  const inferredCookTags = inferCookTagOptionsFromRegistry(reg);
  const serialized = serializeRegistryState(
    reg.header,
    reg.assets,
    reg.dependencySection,
    reg.packages,
    inferredCookTags,
  );
  const again = loadRegistryLoose(serialized);

  const allMismatches = compareRegistries(reg, again);
  const mismatches = allMismatches.slice(0, MAX_MISMATCHES);
  const allWireMismatches = compareWire(reg, again);
  const wireMismatches = allWireMismatches.slice(0, MAX_MISMATCHES);

  const useVerbatim = Boolean(options?.verbatim && options?.writeToPath);
  if (options?.writeToPath) {
    writeFileSync(options.writeToPath, useVerbatim ? input : serialized);
  }

  const bytesCompared = useVerbatim ? input : serialized;
  const bytesIdentical = input.length === bytesCompared.length && input.equals(bytesCompared);
  const semanticOk = allMismatches.length === 0;
  const wireOk = allWireMismatches.length === 0;
  const strictWire = Boolean(options?.strictWire);
  const ok = strictWire ? semanticOk && wireOk : semanticOk;
  const regressionFailures: string[] = [];
  if (!wireOk) {
    regressionFailures.push("wire-regression");
  }
  if (!semanticOk) {
    regressionFailures.push("semantic-regression");
  }

  return {
    ok,
    bytesIdentical,
    semanticOk,
    wireOk,
    strictWire,
    inputBytes: input.length,
    outputBytes: useVerbatim ? input.length : serialized.length,
    mismatchCount: allMismatches.length,
    mismatches,
    wireMismatchCount: allWireMismatches.length,
    wireMismatches,
    regressionChecks: {
      passed: regressionFailures.length === 0,
      failures: regressionFailures,
    },
    outputPath: options?.writeToPath,
  };
}
