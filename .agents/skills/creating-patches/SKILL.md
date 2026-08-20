---
name: creating-patches
description: Creates and maintains Pi package patches in pi-patches. Use when adding, rebasing, testing, renaming, or removing patch directories, manifest entries, or patch tests.
---

# Creating Pi patches

Use this workflow inside the `pi-patches` repo.

## Patch shape

- Create one directory per behavior, named without the package prefix.
- Add exactly these files: `README.md`, `patch.diff`, `patch.test.mjs`.
- Add the directory to `manifest.json` under the patched package, in apply order.
- Keep package versions in `package.json`; do not encode versions in directory names.

## Patch diff rules

- Patch the published package output, usually `dist/**`.
- Author `patch.diff` against the pristine published package (the `npm pack` tarball of the pinned version), never against an already-patched tree. `pnpm patches:sync` combines patches by staging: it applies each patch in manifest order with GNU patch (offset search absorbs line drift; `--fuzz=0` forbids fuzzy matches), then regenerates `combined/` as one self-consistent diff in deterministic pure-Node output and self-verifies it by round-tripping through GNU patch.
- Keep `patch.diff` applicable with `patch --batch --fuzz=0 -p1` from the package root.
- Keep each behavior scoped to its own patch directory, even when two behaviors patch different hunks in the same package file.
- Do not let two patches for the same package touch overlapping hunks; `pnpm patches:sync` rejects overlapping hunk ranges (in pristine coordinates).

## Test rules

- `patch.test.mjs` must be a Vitest test (`describe`/`it`/`expect` from `vitest`) that imports the patched package by name from `node_modules`.
- Test the externally visible behavior, not private implementation details when possible.
- The test should fail on the unpatched package.

## Required checks

```sh
pnpm patches:sync
pnpm install
pnpm test:patches
```

`combined/` is generated and ignored. Do not stage it.

## Running the patched pi binary locally

The fastest way to smoke-test patches against a real CLI is the `pi` binary in
this repo's own `node_modules` — `pnpm install` applies the combined diffs, so
it is the exact artifact CI tests:

```sh
pnpm install
./node_modules/.bin/pi --version   # boots the patched CLI
./node_modules/.bin/pi              # fully patched interactive session
```

Check the patch surface the same way: `./node_modules/.bin/pi --help` (removed
flags/commands must not appear) and `node -e "import('./node_modules/@earendil-works/pi-coding-agent/dist/index.js').then(m => console.log(Object.keys(m)))"`
for the public API.

The Nix build (`pi-cli-patched` in the homelab flake) reads `manifest.json` and
applies each patch with GNU patch on top of the `pi-cli` package. It points at
`github:aliou/pi-patches`, so testing uncommitted local patches needs an
override:

```sh
nix build ~/code/src/code.378labs.dev/homelab/pkgs#pi-cli-patched \
  --override-input pi-patches ~/code/src/pi.dev/pi-patches
./result/bin/pi --version
```

A source assertion like checking a removed statement's neighbor still exists,
or a `--version` smoke run via `spawnSync`, belongs in `patch.test.mjs` when a
patch deletes a code block — deleting one line too many in `main.js` once
turned every startup into a `ReferenceError`.
