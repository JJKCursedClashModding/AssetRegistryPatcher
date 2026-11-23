// Build bin/AssetRegistryGenerator.exe as a Node single executable application (SEA):
// bundle dist/cli.js to one CommonJS file, make a SEA blob, inject it into a copy of node.exe.
// Run after `npm run build`. Windows only (the target is a Windows exe).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = "bin";
const exe = path.join(out, "AssetRegistryGenerator.exe");
const bundle = path.join(out, "cli.cjs");
const blob = path.join(out, "sea-prep.blob");
const config = path.join(out, "sea-config.json");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["dist/cli.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: bundle,
  logLevel: "warning",
});
writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
copyFileSync(process.execPath, exe);
execFileSync(
  process.execPath,
  [
    path.join("node_modules", "postject", "dist", "cli.js"),
    exe,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit" },
);
for (const f of [bundle, blob, config]) rmSync(f);
console.log(`built ${exe}`);
