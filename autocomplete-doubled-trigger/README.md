# pi-tui -- doubled trigger char re-triggers autocomplete

## Why

Some autocomplete providers want a "double trigger" convention: a bare
trigger char (e.g. `?`) shows nothing, `?<letter>` filters, and typing the
trigger char twice (`??`) shows the full list. The pi-harness `?` skill
autocomplete needs exactly this.

The stock editor only auto-triggers a trigger char at a token boundary
(start of line, or preceded by a space/tab). When the provider returns no
items for the bare `?`, the popup closes and there is no live autocomplete
session left. The second `?` sits right after the first `?`, which is not a
boundary, so `insertCharacter` never calls `tryTriggerAutocomplete()` again
and the popup stays closed forever.

## What changes

In `dist/components/editor.js`, `insertCharacter`'s trigger-char branch
(inside `if (!this.autocompleteState)`) gains an `else if`: when the typed
char fails the normal boundary check but repeats the character immediately
before it, and that pair itself sits at a boundary (start of line, or
preceded by a space/tab, or the pair is the whole line so far), it still
calls `tryTriggerAutocomplete()`.

This only affects the no-live-session path. When a popup is already active
(e.g. typing `@@`), the `else` branch (`updateAutocomplete()`) still runs
unchanged. Single triggers at a boundary, mid-token repeats like `x??`, and
the letter-based branch are all unchanged.

## Files

- `patch.diff` -- unified diff against the installed package's
  `dist/components/editor.js`.
- `patch.test.mjs` -- imports the patched `Editor` by package name and
  drives `insertCharacter` calls to assert the new re-trigger behavior,
  that bare/mid-token cases are unaffected, and that the default `@` flow
  (which goes through `updateAutocomplete`) is unchanged. Fails on
  unpatched code.

## How it is applied & tested

`manifest.json` lists this directory under `@earendil-works/pi-tui`.
`pnpm patches:sync` folds it into `combined/pi-tui.diff`;
`pnpm install` applies it. Nix consumers apply `patch.diff` directly.

Run: `pnpm install && pnpm test:patches` (or `pnpm vitest run
autocomplete-doubled-trigger` for just this patch).

## Testing against a new pi-tui release

Authored and verified against 0.84.2. If a future pi-tui bump changes the
shape of `insertCharacter`, `pnpm install` will fail to apply this patch --
rebase `patch.diff` onto the new source.
