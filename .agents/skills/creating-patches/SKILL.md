---
name: creating-patches
description: Creates and maintains Pi package patches in pi-patches. Use when adding, rebasing, testing, renaming, or removing patch directories, manifest entries, or patch tests.
---

# Creating Pi patches

Use this workflow inside the `pi-patches` repo.

## Patch shape

- Create one directory per behavior, named without the package prefix.
- Add exactly these files: `README.md`, `patch.diff`, `test.mjs`.
- Add the directory to `manifest.json` under the patched package, in apply order.
- Keep package versions in `package.json`; do not encode versions in directory names.

## Patch diff rules

- Patch the published package output, usually `dist/**`.
- Keep `patch.diff` applicable with `patch --batch --fuzz=0 -p1` from the package root.
- Keep each behavior scoped to its own patch directory, even when two behaviors patch different hunks in the same package file.
- Do not let two patches for the same package touch overlapping hunks; `pnpm patches:sync` rejects overlapping hunk ranges.

## Test rules

- `test.mjs` must import the patched package by name from `node_modules`.
- Test the externally visible behavior, not private implementation details when possible.
- The test should fail on the unpatched package.

## Required checks

```sh
pnpm patches:sync
pnpm install
pnpm test:patches
```

`combined/` is generated and ignored. Do not stage it.
