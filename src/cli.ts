import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  fNameToString,
  inferCookTagOptionsFromRegistry,
  joinTopLevelPath,
  loadRegistryLoose,
  mergeAssetRowsAppendOnly,
  parseStrictJson,
  serializeRegistryState,
} from "./unreal/index.js";
import {
  assertRegistryRows,
  loadedAssetDataFromRegistryRow,
} from "./manifestToRow.js";

function usage(): string {
  return `Usage:
  node cli.js merge --base <AssetRegistry.bin> --rows <rows.json> --out <AssetRegistry.out.bin>
  node cli.js print-row --bin <AssetRegistry.bin> --row <PackageName|ObjectName|PackagePath.ObjectName>
  node cli.js print-rows --bin <AssetRegistry.bin>

Commands:
  merge       Reads a cooked v16 base registry, appends rows from a JSON array of registry rows
              (append-only; skips rows whose package+asset already exist), and writes a new .bin.
              Each row must have: packageName, objectName. Optional: classPath, packageFlags,
              packageFlagsHex (ignored), chunkIds, tags, bundles.
  print-row   Loads a cooked v16 registry .bin and prints all rows whose PackageName or ObjectName matches --row.
              Matching is case-insensitive; partial substring matches are supported.
  print-rows  Loads a cooked v16 registry .bin and prints ALL rows as a JSON array to stdout.`;
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) {
    return undefined;
  }
  return argv[i + 1];
}

function assetIdentityKey(packageName: string, assetName: string): string {
  return `${packageName}\x1f${assetName}`;
}

function mergeCommand(argv: string[]): void {
  const basePath = argValue(argv, "--base");
  const rowsPath = argValue(argv, "--rows");
  const outPath = argValue(argv, "--out");
  if (!basePath || !rowsPath || !outPath) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const baseAbs = path.resolve(basePath);
  const rowsAbs = path.resolve(rowsPath);
  const outAbs = path.resolve(outPath);

  const rowsText = readFileSync(rowsAbs, "utf8");
  const rowsJson = parseStrictJson(rowsText, rowsAbs);
  const rows = assertRegistryRows(rowsJson, rowsAbs);

  const baseBuf = readFileSync(baseAbs);
  const reg = loadRegistryLoose(baseBuf);

  const candidateAssets = rows.map((r, i) => {
    const ctx = `${rowsAbs}[${i}]`;
    return loadedAssetDataFromRegistryRow(r, ctx);
  });

  const seen = new Set<string>(
    reg.assets.map((a) => assetIdentityKey(fNameToString(a.packageName), fNameToString(a.assetName))),
  );
  const newAssets = [];
  let ignoredRows = 0;
  for (const a of candidateAssets) {
    const packageName = fNameToString(a.packageName);
    const assetName = fNameToString(a.assetName);
    const key = assetIdentityKey(packageName, assetName);
    if (seen.has(key)) {
      ignoredRows += 1;
      console.error(
        `Ignoring row due to existing package+asset: ${JSON.stringify(packageName)} / ${JSON.stringify(assetName)}`,
      );
      continue;
    }
    seen.add(key);
    newAssets.push(a);
  }
  const mergedAssets = mergeAssetRowsAppendOnly(reg.assets, newAssets);
  const cookOpts = inferCookTagOptionsFromRegistry(reg);
  const out = serializeRegistryState(
    reg.header,
    mergedAssets,
    reg.dependencySection,
    reg.packages,
    cookOpts,
  );
  writeFileSync(outAbs, out);
  loadRegistryLoose(out);
  console.error(
    `Wrote ${outAbs} (${mergedAssets.length} asset rows, ${reg.packages.length} package rows from base, ignored ${ignoredRows} colliding row(s)).`,
  );
}

function loadedAssetDataToJson(a: ReturnType<typeof loadRegistryLoose>["assets"][number]): Record<string, unknown> {
  const packageFlagsHex = `0x${(a.packageFlags >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  const classPath = joinTopLevelPath(a.assetClassPathPackage, a.assetClassPathAsset);
  return {
    packageName: fNameToString(a.packageName),
    objectName: fNameToString(a.assetName),
    packagePath: fNameToString(a.packagePath),
    classPath,
    packageFlags: a.packageFlags,
    packageFlagsHex,
    chunkIds: [...a.chunkIds],
    tags: { ...a.tags },
    bundles: a.bundles.map((b) => ({
      bundleName: fNameToString(b.bundleName),
      paths: b.paths.map((p) =>
        p.assetPart && fNameToString(p.assetPart) && fNameToString(p.assetPart) !== "None"
          ? `${fNameToString(p.packagePart)}.${fNameToString(p.assetPart)}`
          : fNameToString(p.packagePart),
      ),
    })),
  };
}

function printRowsCommand(argv: string[]): void {
  const binPath = argValue(argv, "--bin");
  if (!binPath) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const binAbs = path.resolve(binPath);
  const binBuf = readFileSync(binAbs);
  const reg = loadRegistryLoose(binBuf);

  console.error(`Total rows: ${reg.assets.length}`);
  console.log(JSON.stringify(reg.assets.map(loadedAssetDataToJson), null, 2));
}

function printRowCommand(argv: string[]): void {
  const binPath = argValue(argv, "--bin");
  const rowArg = argValue(argv, "--row");
  if (!binPath || !rowArg) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const binAbs = path.resolve(binPath);
  const binBuf = readFileSync(binAbs);
  const reg = loadRegistryLoose(binBuf);

  // Normalize search term: strip leading/trailing whitespace and lowercase.
  const needle = rowArg.trim().toLowerCase();

  // Support "PackageName.ObjectName" notation as well as bare package or object names.
  const dotIdx = needle.lastIndexOf(".");
  const needlePkg = dotIdx >= 0 ? needle.slice(0, dotIdx) : needle;
  const needleAsset = dotIdx >= 0 ? needle.slice(dotIdx + 1) : needle;

  const matches = reg.assets.filter((a) => {
    const pkgStr = fNameToString(a.packageName).toLowerCase();
    const assetStr = fNameToString(a.assetName).toLowerCase();

    if (dotIdx >= 0) {
      // User gave "Pkg.Asset" — require both parts to match.
      return pkgStr.includes(needlePkg) && assetStr.includes(needleAsset);
    }
    // Otherwise match against either field.
    return pkgStr.includes(needle) || assetStr.includes(needle);
  });

  if (matches.length === 0) {
    console.error(`No rows found matching: ${JSON.stringify(rowArg)}`);
    process.exitCode = 1;
    return;
  }

  if (matches.length === 1) {
    console.log(JSON.stringify(loadedAssetDataToJson(matches[0]!), null, 2));
  } else {
    console.error(`Found ${matches.length} matching rows:`);
    console.log(JSON.stringify(matches.map(loadedAssetDataToJson), null, 2));
  }
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "merge") {
  mergeCommand(argv);
} else if (cmd === "print-row") {
  printRowCommand(argv);
} else if (cmd === "print-rows") {
  printRowsCommand(argv);
} else {
  console.error(usage());
  process.exitCode = 1;
}
