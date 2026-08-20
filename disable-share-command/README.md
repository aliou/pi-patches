# disable-share-command -- remove the builtin /share command

## What this patch does

Removes the builtin `/share` command (export session to HTML, upload as a secret
GitHub gist via `gh`, print a pi.dev viewer URL) so an extension can own the
`/share` name.

- `dist/modes/interactive/interactive-mode.js` — deletes the editor-submit
  dispatch block for `/share`. Unmatched slash commands fall through to
  `session.prompt()`, where extension commands dispatch natively.
- `dist/core/slash-commands.js` — removes `share` from `BUILTIN_SLASH_COMMANDS`,
  which frees the name in autocomplete and silences the builtin-conflict
  warning for an extension command named `share`.
- `dist/cli/args.js` — drops the `PI_SHARE_VIEWER_URL` env-var help line that
  documents the removed command.

`handleShareCommand()` (the method) stays as unreachable code to keep the diff
minimal.

## Why

Builtins win by construction: the submit handler intercepts `/share` before
extensions see it, and `BUILTIN_SLASH_COMMANDS` filters the name out of
autocomplete. Registering `/share` from an extension is impossible without this
patch.

## Testing

```sh
pnpm patches:sync
pnpm install
pnpm test:patches
```

The test verifies `BUILTIN_SLASH_COMMANDS` no longer lists `share` and the
interactive submit handler no longer intercepts `/share`.
