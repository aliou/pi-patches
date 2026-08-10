#!/usr/bin/env node
// @aliou/pi-patches pi-version bumper.
//
// Rewrites `package.json` to point its `@earendil-works/*` dependencies
// at a target version. Run `pnpm patches:sync` after bumping so
// `pnpm-workspace.yaml` points patchedDependencies at the same versions.
//
// This lets the nightly workflow test patches against a newer pi release
// without touching the repo's main package.json. The change is ephemeral in CI
// (not committed); locally, review the diff before committing to pin.
//
// Target version resolution (first match wins):
//   1. PI_VERSION env var — applied to every @earendil-works/* dep.
//   2. Each package's latest published version (`npm view <pkg> version`).
//
// Usage:
//   node scripts/bump-pi-version.mjs                 # bump each to its latest
//   PI_VERSION=0.82.0 node scripts/bump-pi-version.mjs   # bump all to a specific version

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PKG_FILE = "package.json";
const SCOPE = "@earendil-works";

const pkg = JSON.parse(readFileSync(PKG_FILE, "utf8"));
const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith(`${SCOPE}/`));
if (deps.length === 0) {
  console.error(`no ${SCOPE}/* dependencies found in ${PKG_FILE}`);
  process.exit(1);
}

let changed = false;
for (const dep of deps) {
  const current = pkg.dependencies[dep];
  const target = process.env.PI_VERSION || execSync(`npm view ${dep} version`, { encoding: "utf8" }).trim();
  if (!target) {
    console.error(`could not resolve target version for ${dep}`);
    process.exit(1);
  }
  if (current === target) {
    console.log(`${dep}: already at ${target}`);
    continue;
  }
  console.log(`${dep}: ${current} -> ${target}`);
  pkg.dependencies[dep] = target;
  changed = true;
}

if (!changed) {
  console.log("no changes");
  process.exit(0);
}

writeFileSync(PKG_FILE, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`bumped ${PKG_FILE}`);
