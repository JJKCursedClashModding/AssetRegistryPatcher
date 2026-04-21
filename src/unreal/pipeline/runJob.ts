import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandFilesToPack } from "../job/expandFilesToPack.js";
import {
  resolvedContentMount,
  resolvedContentOptions,
  type JobFileV1,
  type JobReplaceEntry,
  type RegistryRowBase,
} from "../job/schema.js";
import { resolveJobRegistryBase } from "../registry/resolveRegistryBaseRef.js";
import { ensureDirForFile, resolveUnderRoot, toPosixAssetPath } from "../path/safePaths.js";
import type { LoadedAssetData } from "../registry/assetData.js";
import { fNameToString } from "../registry/fnameWire.js";
import { assetIdentityKey, identityFromAssetPath } from "../registry/identity.js";
import { loadRegistryLoose } from "../registry/loadRegistry.js";
import {
  inferCookTagOptionsFromRegistry,
  saveRegistryWithOnlyStagedAssets,
  saveRegistryWithStagedAssets,
} from "../registry/saveRegistry.js";
import { packageDataV16FromCookedAssetFile, type LoadedPackageDataV16 } from "../registry/packageDataRw.js";
import { loadedAssetDataFromStagingHints } from "../registry/stagingAsset.js";
import { copySidecarsBesideUasset } from "./copySidecars.js";
import { replaceInString, replaceInTagValuesEntry } from "./replace.js";
import { runRepackZen } from "./repackZen.js";
import { invocationFromJob, runFromJson, runToJson } from "./uassetGui.js";
import { extractTagHintsFromUAssetGuiJson } from "./uassetJsonHints.js";

function isPrimaryAssetPath(p: string): boolean {
  const x = p.toLowerCase();
  return x.endsWith(".uasset") || x.endsWith(".umap");
}

function primaryAssetExt(p: string): ".uasset" | ".umap" | null {
  const x = p.toLowerCase();
  if (x.endsWith(".uasset")) {
    return ".uasset";
  }
  if (x.endsWith(".umap")) {
    return ".umap";
  }
  return null;
}

export interface RunJobResult {
  stagedAssets: string[];
  jsonHintsByAsset: Record<string, Record<string, string>>;
  registryWritten: boolean;
  registryNewRowsOnlyWritten?: boolean;
  /** Present when the job had `repack: true`. */
  repack?: {
    utocPath: string;
    registryPakPath: string;
    ioBase: string;
    backend: "retoc" | "unrealrezen";
    /** Absolute dir where `.utoc` / `.ucas` / registry `.pak` were copied when `copyOnCompletePath` was set. */
    artifactsCopiedTo?: string;
  };
}

/**
 * Executes staging + UAssetGUI (PLAN.md), then writes `registryOutputPath` by merging staged rows
 * into the input registry (replace by package+asset identity, append new packages/rows).
 */
export function runJob(job: JobFileV1, cwd: string = process.cwd()): RunJobResult {
  const pkgRoot = path.resolve(cwd, job.packageRoot);
  const stagingRoot = path.resolve(cwd, job.stagingRoot);
  const regIn = path.resolve(cwd, job.registryInputPath);
  const regOut = path.resolve(cwd, job.registryOutputPath);
  const regOutNewOnly =
    job.registryNewRowsOnlyOutputPath !== undefined
      ? path.resolve(cwd, job.registryNewRowsOnlyOutputPath)
      : undefined;

  if (path.resolve(regIn).toLowerCase() === path.resolve(regOut).toLowerCase()) {
    throw new Error("registryInputPath and registryOutputPath must differ (after resolve).");
  }
  if (regOutNewOnly !== undefined) {
    const regOutNewOnlyLc = path.resolve(regOutNewOnly).toLowerCase();
    if (path.resolve(regIn).toLowerCase() === regOutNewOnlyLc) {
      throw new Error(
        "registryInputPath and registryNewRowsOnlyOutputPath must differ (after resolve).",
      );
    }
    if (path.resolve(regOut).toLowerCase() === regOutNewOnlyLc) {
      throw new Error(
        "registryOutputPath and registryNewRowsOnlyOutputPath must differ (after resolve).",
      );
    }
  }
  if (path.resolve(pkgRoot) === path.resolve(stagingRoot)) {
    throw new Error("packageRoot and stagingRoot must not be the same directory.");
  }

  // Always start from a clean staging tree so stale assets cannot be repacked inadvertently.
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  for (const e of job.filesToEdit) {
    if (e.method !== "replace") {
      throw new Error(`Unsupported method "${e.method}" (only "replace").`);
    }
    if (!isPrimaryAssetPath(e.assetPath)) {
      throw new Error(`filesToEdit assetPath must end with .uasset or .umap: ${e.assetPath}`);
    }
    if (e.outputAssetPath !== undefined && !isPrimaryAssetPath(e.outputAssetPath)) {
      throw new Error(
        `filesToEdit outputAssetPath must end with .uasset or .umap: ${e.outputAssetPath}`,
      );
    }
    if (e.outputAssetPath !== undefined) {
      const a = primaryAssetExt(e.assetPath);
      const o = primaryAssetExt(e.outputAssetPath);
      if (a !== o) {
        throw new Error(
          `filesToEdit outputAssetPath extension must match assetPath (${a} vs ${o}).`,
        );
      }
    }
  }

  const editResolved = job.filesToEdit.map((e) => {
    const sourcePosix = toPosixAssetPath(e.assetPath);
    const stagingPosix =
      e.outputAssetPath !== undefined && e.outputAssetPath.length > 0
        ? toPosixAssetPath(e.outputAssetPath)
        : sourcePosix;
    return { sourcePosix, stagingPosix, entry: e };
  });
  const packed = expandFilesToPack(pkgRoot, job.filesToPack);
  const allPosix = [...editResolved.map((r) => r.stagingPosix), ...packed.map((p) => p.posix)];
  const pathSet = new Set<string>();
  for (const p of allPosix) {
    if (pathSet.has(p)) {
      throw new Error(`Duplicate assetPath across filesToEdit / filesToPack: ${p}`);
    }
    pathSet.add(p);
  }

  const contentMount = resolvedContentMount(job);
  const contentOpts = resolvedContentOptions(job);
  const baseRegistry = loadRegistryLoose(readFileSync(regIn));
  const manualCookTagOptions = {
    cookTagsAsName:
      job.cookTagsAsName !== undefined ? new Set(job.cookTagsAsName) : undefined,
    cookTagsAsPath:
      job.cookTagsAsPath !== undefined ? new Set(job.cookTagsAsPath) : undefined,
  };
  const cookTagOptions = job.inferCookTags
    ? inferCookTagOptionsFromRegistry(baseRegistry)
    : manualCookTagOptions;

  const registryByIdentity = new Map<string, LoadedAssetData>();
  for (const a of baseRegistry.assets) {
    registryByIdentity.set(
      assetIdentityKey(fNameToString(a.packageName), fNameToString(a.assetName)),
      a,
    );
  }

  const baseByPosix = new Map<string, RegistryRowBase | undefined>();
  for (const { stagingPosix, entry } of editResolved) {
    baseByPosix.set(
      stagingPosix,
      resolveJobRegistryBase(
        entry.base !== undefined ? entry.base : entry.assetPath,
        registryByIdentity,
        contentMount,
        contentOpts,
        `filesToEdit base (assetPath ${entry.assetPath})`,
      ),
    );
  }
  for (const { posix, base } of packed) {
    baseByPosix.set(
      posix,
      resolveJobRegistryBase(
        base !== undefined ? base : posix,
        registryByIdentity,
        contentMount,
        contentOpts,
        `filesToPack base (${posix})`,
      ),
    );
  }

  const tagsFromInputRegistry = (posix: string): Record<string, string> => {
    const id = identityFromAssetPath(posix, contentMount, contentOpts);
    const row = registryByIdentity.get(assetIdentityKey(id.packageName, id.assetName));
    return row ? { ...row.tags } : {};
  };
  const registryTagsByStagingPosix = new Map<string, Record<string, string>>();
  for (const { sourcePosix, stagingPosix } of editResolved) {
    registryTagsByStagingPosix.set(stagingPosix, tagsFromInputRegistry(sourcePosix));
  }
  for (const { posix } of packed) {
    registryTagsByStagingPosix.set(posix, tagsFromInputRegistry(posix));
  }

  const staged: string[] = [];
  const hints: Record<string, Record<string, string>> = {};
  const jobIdentityKeys = new Set<string>();

  const assertUniqueIdentityInJob = (posix: string) => {
    const id = identityFromAssetPath(posix, contentMount, contentOpts);
    const k = assetIdentityKey(id.packageName, id.assetName);
    if (jobIdentityKeys.has(k)) {
      throw new Error(`Duplicate logical asset identity in this job for "${posix}".`);
    }
    jobIdentityKeys.add(k);
  };

  let tmpDir = "";
  try {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "jjku-ar-"));
    const inv = invocationFromJob(job, cwd);

    let tmpSeq = 0;
    const tmpJsonPath = () => path.join(tmpDir, `step-${tmpSeq++}.json`);

    for (const { sourcePosix, stagingPosix, entry } of editResolved) {
      assertUniqueIdentityInJob(stagingPosix);
      const src = resolveUnderRoot(pkgRoot, sourcePosix);
      const dest = resolveUnderRoot(stagingRoot, stagingPosix);
      ensureDirForFile(dest);
      const tmpJson = tmpJsonPath();
      runToJson(inv, src, tmpJson);
      let text = readFileSync(tmpJson, "utf8");
      for (const r of entry.replace) {
        text = replaceInString(text, r);
      }
      const setFields = entry.setField ?? [];
      if (setFields.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            `filesToEdit JSON parse failed after replace (${entry.assetPath}): ${msg}`,
          );
        }
        for (let fi = 0; fi < setFields.length; fi++) {
          const fn = setFields[fi]!;
          try {
            fn(parsed);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(
              `filesToEdit setField[${fi}] (${entry.assetPath}): ${msg}`,
            );
          }
        }
        const endsWithNl = /\n\s*$/.test(text);
        text = JSON.stringify(parsed) + (endsWithNl ? "\n" : "");
      }
      writeFileSync(tmpJson, text, "utf8");
      runFromJson(inv, tmpJson, dest);
      copySidecarsBesideUasset(src, dest);
      hints[stagingPosix] = extractTagHintsFromUAssetGuiJson(text);
      staged.push(stagingPosix);
    }

    for (const { posix } of packed) {
      assertUniqueIdentityInJob(posix);
      const src = resolveUnderRoot(pkgRoot, posix);
      const dest = resolveUnderRoot(stagingRoot, posix);
      ensureDirForFile(dest);
      const tmpJson = tmpJsonPath();
      runToJson(inv, src, tmpJson);
      const text = readFileSync(tmpJson, "utf8");
      hints[posix] = extractTagHintsFromUAssetGuiJson(text);
      copyFileSync(src, dest);
      copySidecarsBesideUasset(src, dest);
      staged.push(posix);
    }
  } finally {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const replaceByStagingPosix = new Map<string, JobReplaceEntry[]>();
  for (const { stagingPosix, entry } of editResolved) {
    replaceByStagingPosix.set(stagingPosix, entry.replace);
  }

  const stagedRows = staged.map((posix) => {
    let row = loadedAssetDataFromStagingHints(
      posix,
      contentMount,
      contentOpts,
      hints[posix] ?? {},
      baseByPosix.get(posix),
      registryTagsByStagingPosix.get(posix),
    );
    const rep = replaceByStagingPosix.get(posix);
    if (rep) {
      let tags = row.tags;
      for (const entry of rep) {
        tags = replaceInTagValuesEntry(tags, entry);
      }
      row = { ...row, tags };
    }
    return row;
  });
  const packageDataByPackageName = new Map<string, LoadedPackageDataV16>();
  for (let i = 0; i < staged.length; i++) {
    const posix = staged[i]!;
    const row = stagedRows[i]!;
    const packageName = fNameToString(row.packageName);
    if (packageDataByPackageName.has(packageName)) {
      continue;
    }
    const stagedFile = resolveUnderRoot(stagingRoot, posix);
    packageDataByPackageName.set(
      packageName,
      packageDataV16FromCookedAssetFile(stagedFile, packageName),
    );
  }

  const outBuf = saveRegistryWithStagedAssets(
    baseRegistry,
    stagedRows,
    cookTagOptions,
    packageDataByPackageName,
  );
  ensureDirForFile(regOut);
  writeFileSync(regOut, outBuf);
  loadRegistryLoose(outBuf);
  let registryNewRowsOnlyWritten = false;
  if (regOutNewOnly !== undefined) {
    const outBufNewOnly = saveRegistryWithOnlyStagedAssets(
      baseRegistry,
      stagedRows,
      cookTagOptions,
      packageDataByPackageName,
    );
    ensureDirForFile(regOutNewOnly);
    writeFileSync(regOutNewOnly, outBufNewOnly);
    loadRegistryLoose(outBufNewOnly);
    registryNewRowsOnlyWritten = true;
  }

  let repack: RunJobResult["repack"];
  if (job.repack === true) {
    const backend = job.repackBackend ?? "retoc";
    let registryForPak = regOut;
    if (job.newRowsOnlyInRegistry === true) {
      if (regOutNewOnly === undefined) {
        throw new Error(
          "newRowsOnlyInRegistry requires registryNewRowsOnlyOutputPath (job validation should have caught this)",
        );
      }
      registryForPak = regOutNewOnly;
    }
    repack = runRepackZen({
      cwd,
      stagingRoot,
      backend,
      gamePaksDir:
        backend === "unrealrezen"
          ? path.resolve(cwd, job.repackGamePaksPath!)
          : undefined,
      repackOutputDir: job.repackOutputPath!,
      mergedRegistryPath: registryForPak,
      ioBase: job.repackName,
    });
    if (job.copyOnCompletePath !== undefined) {
      const destDir = path.resolve(cwd, job.copyOnCompletePath);
      mkdirSync(destDir, { recursive: true });
      const outDir = path.dirname(repack.utocPath);
      const ucasPath = path.join(outDir, `${repack.ioBase}.ucas`);
      const triple: [string, string][] = [
        [repack.utocPath, path.join(destDir, path.basename(repack.utocPath))],
        [ucasPath, path.join(destDir, path.basename(ucasPath))],
        [repack.registryPakPath, path.join(destDir, path.basename(repack.registryPakPath))],
      ];
      for (const [src, dest] of triple) {
        if (!existsSync(src)) {
          throw new Error(`copyOnCompletePath: expected file missing: ${src}`);
        }
        copyFileSync(src, dest);
      }
      repack = { ...repack, artifactsCopiedTo: destDir };
    }
  }

  return {
    stagedAssets: staged,
    jsonHintsByAsset: hints,
    registryWritten: true,
    registryNewRowsOnlyWritten,
    repack,
  };
}
