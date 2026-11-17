#!/usr/bin/env node
// Bump the leaf desktop version in every manifest, commit, and tag v<version>.
//
//   mise run release 0.2.0
//
// Updates: Cargo.toml ([workspace.package] version, inherited by all crates),
// Cargo.lock, src-tauri/tauri.conf.json and package.json. Never pushes.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  // With stdio "inherit" there is no captured output (null).
  const out = execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...opts });
  return (out ?? "").trim();
}

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!SEMVER.test(version)) fail(`"${process.argv[2] ?? ""}" is not a semver version (e.g. 0.2.0)`);
const tag = `v${version}`;

if (run("git", ["status", "--porcelain"]) !== "") fail("working tree is not clean");
if (run("git", ["tag", "--list", tag]) !== "") fail(`tag ${tag} already exists`);

// Cargo.toml: only the version inside [workspace.package].
const cargoPath = join(root, "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const section = /(\[workspace\.package\][^[]*?\nversion\s*=\s*")([^"]+)(")/;
const current = cargo.match(section)?.[2];
if (!current) fail("could not find version in [workspace.package] of Cargo.toml");
if (current === version) fail(`version is already ${version}`);
writeFileSync(cargoPath, cargo.replace(section, `$1${version}$3`));

// JSON manifests (reformatted with Biome below).
const jsonFiles = ["src-tauri/tauri.conf.json", "package.json"];
for (const file of jsonFiles) {
  const path = join(root, file);
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.version = version;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

try {
  // JSON.stringify expands short arrays that Biome keeps inline; reformat so
  // the release commit passes `mise run fmt-check`.
  run("pnpm", ["biome", "format", "--write", ...jsonFiles], { stdio: "inherit" });

  // Refresh workspace entries in Cargo.lock without touching dependencies.
  run("cargo", ["update", "--workspace", "--offline"], { stdio: "inherit" });

  run("git", ["add", "Cargo.toml", "Cargo.lock", ...jsonFiles]);
  run("git", ["commit", "-m", `chore(release): ${tag}`], { stdio: "inherit" });
  run("git", ["tag", "-a", tag, "-m", `leaf ${tag}`]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  fail("aborted; undo partial changes with `git reset --hard HEAD` if nothing was committed");
}

console.log(`\nBumped ${current} -> ${version} and tagged ${tag}.`);
console.log("Push when ready:\n  git push origin main --follow-tags");
