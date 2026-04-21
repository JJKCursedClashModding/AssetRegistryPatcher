#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadJobFile } from "./job/loadJobFile.js";
import { assertJobShape } from "./job/schema.js";
import { runJob } from "./pipeline/runJob.js";
import { loadRegistryLoose } from "./registry/loadRegistry.js";
import { buildEmptyAssetRegistryBin } from "./registry/saveRegistry.js";
import { verifyRegistryRoundTrip } from "./registry/roundTrip.js";

function usage(): void {
  console.log(`jjku-ar — AssetRegistry.bin (v16) loader (see PLAN.md)

Usage:
  jjku-ar load <AssetRegistry.bin> [--json]
  jjku-ar round-trip <AssetRegistry.bin> [--out <path>] [--verbatim] [--strict-wire]
  jjku-ar build-empty <output.bin>
  jjku-ar run-job <job.json|job.ts>
  jjku-ar start [jobname]
  jjku-ar help

run-job:
  Stages assets under stagingRoot (UAssetGUI + sidecars), merges rebuilt rows into the input registry,
  and writes registryOutputPath (v16 AssetRegistry.bin). Optional:
  registryNewRowsOnlyOutputPath writes a second registry containing only newly staged rows.
  Optional job fields repack + repackOutputPath (+ repackBackend retoc|unrealrezen, repackGamePaksPath when unrealrezen) + optional repackName: IoStore pack + repak registry .pak.
  Optional newRowsOnlyInRegistry: when true with repack, pack registryNewRowsOnlyOutputPath into the registry .pak instead of the merged registryOutputPath.
  Optional copyOnCompletePath (requires repack): copy generated .utoc, .ucas, and registry .pak to that directory after repack.

round-trip:
  Load → serialize → load in memory; reports byte identity and semantic diffs (first fields only).
  Use --out to write the serialized .bin for external diffing.
  Use --verbatim with --out to write the original bytes (guaranteed byte-identical); rebuild path still validates semantics.
  Use --strict-wire to also require exact name-batch/fixed-store/dependency wire parity.

build-empty:
  Write a valid v16 AssetRegistry.bin with zero assets, empty dependency section, and no package rows.

Options:
  --json   Print first asset sample as JSON (debug)

start:
  Resolve a job under jobs/ and run it (same as run-job). With no name, uses jobs/testjob.ts.
  Examples: npm run start -- myjob  →  jobs/myjob.ts
            npm run start -- jobs/sample.job.ts
`);
}

function resolveStartJobPath(cwd: string, nameArg: string | undefined): string {
  const jobsDir = join(cwd, "jobs");
  if (!nameArg || nameArg.startsWith("-")) {
    const def = join(jobsDir, "testjob.ts");
    if (!existsSync(def)) {
      throw new Error(
        `Default job not found: ${def}. Pass a name: npm run start -- <jobname>`,
      );
    }
    return def;
  }
  const explicit =
    nameArg.includes("/") ||
    nameArg.includes("\\") ||
    nameArg.endsWith(".ts") ||
    nameArg.endsWith(".mts") ||
    nameArg.endsWith(".json");
  if (explicit) {
    const p = resolve(cwd, nameArg);
    if (!existsSync(p)) {
      throw new Error(`Job file not found: ${p}`);
    }
    return p;
  }
  for (const ext of [".ts", ".mts", ".json"] as const) {
    const p = join(jobsDir, nameArg + ext);
    if (existsSync(p)) {
      return p;
    }
  }
  throw new Error(
    `No job "${nameArg}" in jobs/ (tried ${nameArg}.ts, ${nameArg}.mts, ${nameArg}.json). ` +
      `Or pass a path: npm run start -- path/to/job.ts`,
  );
}

function executeRunJob(jobPath: string, pathArgForHint: string): void {
  if (!existsSync(jobPath)) {
    console.error(`Job file not found: ${jobPath}`);
    if (pathArgForHint.startsWith(".") && pathArgForHint.length > 1 && !pathArgForHint.startsWith("..")) {
      console.error(
        "If you meant a normal file next to package.json, drop the leading dot (e.g. jobs/testjob.ts not .testjob.ts).",
      );
    }
    process.exit(1);
  }
  let raw: unknown;
  try {
    raw = loadJobFile(jobPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exit(1);
  }
  assertJobShape(raw);
  try {
    const result = runJob(raw, process.cwd());
    console.log(
      JSON.stringify(
        {
          ok: true,
          jobPath,
          stagedCount: result.stagedAssets.length,
          stagedAssets: result.stagedAssets,
          jsonHintsByAsset: result.jsonHintsByAsset,
          registryWritten: result.registryWritten,
          registryNewRowsOnlyWritten: result.registryNewRowsOnlyWritten ?? false,
          repack: result.repack ?? null,
        },
        null,
        2,
      ),
    );
    if (!result.registryWritten) {
      console.error("Warning: registryOutputPath was not written (registryWritten: false).");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exit(1);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    usage();
    process.exit(0);
  }

  if (argv[0] === "start") {
    if (argv[1] === "--help" || argv[1] === "-h") {
      console.log(`jjku-ar start [jobname]

  jobname: stem under jobs/ (tries .ts, .mts, .json), or a relative/absolute path to a job file.
  With no jobname: jobs/testjob.ts

  Examples:
    npm run start -- myjob
    npm run start -- sample.job
    npm run start -- jobs/other_char_animation_copy.ts`);
      process.exit(0);
    }
    const cwd = process.cwd();
    let jobPath: string;
    try {
      jobPath = resolveStartJobPath(cwd, argv[1]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(msg);
      process.exit(1);
    }
    executeRunJob(jobPath, argv[1] ?? "");
    return;
  }

  if (argv[0] === "run-job") {
    const pathArg = argv[1];
    if (!pathArg) {
      console.error("Missing path to job file (.json or .ts)");
      process.exit(1);
    }
    const jobPath = resolve(pathArg);
    executeRunJob(jobPath, pathArg);
    return;
  }

  if (argv[0] === "build-empty") {
    const outArg = argv[1];
    if (!outArg || outArg.startsWith("-")) {
      console.error("Missing output path for AssetRegistry.bin");
      process.exit(1);
    }
    const outPath = resolve(outArg);
    try {
      const buf = buildEmptyAssetRegistryBin();
      writeFileSync(outPath, buf);
      const reg = loadRegistryLoose(buf);
      console.log(
        JSON.stringify(
          {
            ok: true,
            path: outPath,
            bytesWritten: buf.length,
            version: reg.header.version,
            assetCount: reg.assets.length,
            packageCount: reg.packages.length,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(msg);
      process.exit(1);
    }
    return;
  }

  if (argv[0] === "round-trip") {
    const pathArg = argv[1];
    if (!pathArg || pathArg.startsWith("-")) {
      console.error("Missing path to AssetRegistry.bin");
      process.exit(1);
    }
    const outIdx = argv.indexOf("--out");
    const outPath = outIdx >= 0 && argv[outIdx + 1] ? resolve(argv[outIdx + 1]!) : undefined;
    const verbatim = argv.includes("--verbatim");
    const strictWire = argv.includes("--strict-wire");
    if (verbatim && !outPath) {
      console.error("--verbatim requires --out <path>");
      process.exit(1);
    }
    try {
      const buf = readFileSync(resolve(pathArg));
      const result = verifyRegistryRoundTrip(
        buf,
        outPath ? { writeToPath: outPath, verbatim, strictWire } : { strictWire },
      );
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) {
        process.exit(2);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(msg);
      process.exit(1);
    }
    return;
  }

  if (argv[0] === "load") {
    const pathArg = argv[1];
    if (!pathArg) {
      console.error("Missing path to AssetRegistry.bin");
      process.exit(1);
    }
    const wantJson = argv.includes("--json");
    const buf = readFileSync(resolve(pathArg));
    const reg = loadRegistryLoose(buf);
    console.log(
      JSON.stringify(
        {
          version: reg.header.version,
          filterEditorOnly: reg.header.bFilterEditorOnlyData,
          nameCount: reg.nameTable.entries.length,
          assetCount: reg.assets.length,
          packageCount: reg.packages.length,
          dependencySectionBytes: reg.dependencySection.length,
          endOffset: reg.endOffset,
          sample: wantJson ? reg.assets[0] ?? null : undefined,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error("Unknown command. Try: jjku-ar help");
  process.exit(1);
}

main();
