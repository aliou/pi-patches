# pi-patches

Patch set for Pi packages that are still needed outside upstream releases.

## Structure

- `manifest.json` - source of truth. Maps each patched package to the ordered patch directories that apply to it.
- `package.json` - pins the Pi package versions the patches are tested against.
- `<patch-name>/` - one patch directory, named by behavior only. Do not prefix names with the package; the manifest supplies the package.
- `scripts/` - maintenance scripts.
- `combined/` - generated pnpm patch files. Do not commit this directory.

Each ordinary patch directory contains:

- `README.md` - what the patch changes and why.
- `patch.diff` - unified diff against the package's published `dist/**` files.
- `test.mjs` - Node test that imports the patched package and fails on unpatched behavior.

A shared patch directory may contain package-specific diff files instead of a
single `patch.diff`. In that case, list it in `manifest.json` as
`{ "name": "<label>", "dir": "<patch-name>", "patch": "<file>.patch.diff" }`
under each package that should receive one of its diffs. `name` is the label
used in generated combined diffs.

Different patch directories may touch the same package file when their hunks do
not overlap. Keep each behavior scoped to its own patch directory; do not move a
change into another patch directory just because both changes edit the same
published `dist/**` file. `pnpm patches:sync` rejects overlapping hunks.

## Commands

```sh
pnpm patches:sync
pnpm install
pnpm test:patches
```

`pnpm patches:sync` regenerates `pnpm-workspace.yaml` `patchedDependencies` and writes ignored files under `combined/` for pnpm. Run it after changing `manifest.json`, `package.json` versions, or any patch directory list.

`pnpm install` applies the generated combined diffs. `pnpm test:patches` checks generated state first, then runs every patch test.

## Nix consumers

Nix consumers should read `manifest.json` and apply each listed `<patch-name>/patch.diff` directly. Do not depend on `combined/`; it is generated only for pnpm.

## Git hygiene

- Commit patch directories, `manifest.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, scripts, workflow files, and skills.
- Do not commit `combined/` or `node_modules/`.
- Keep this file current when changing layout, commands, or patch workflow.
