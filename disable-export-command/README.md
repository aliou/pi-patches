# disable-export-command -- remove the builtin /export command and --export flag

## What this patch does

Removes both builtin export entry points so an extension can own them and make
the slash command and the CLI flag behave identically.

- `dist/modes/interactive/interactive-mode.js` — deletes the editor-submit
  dispatch block for `/export`. Unmatched slash commands fall through to
  `session.prompt()`, where extension commands dispatch natively.
- `dist/core/slash-commands.js` — removes `export` from `BUILTIN_SLASH_COMMANDS`
  (frees the name in autocomplete, silences the builtin-conflict warning).
- `dist/cli/args.js` — stops parsing `--export`. The flag now lands in
  `unknownFlags`, which flows to extensions as `extensionFlagValues`: an
  extension can claim it with `pi.registerFlag("export", { type: "string" })`
  and read `pi.getFlag("export")`. Also drops the `--export` help line and
  examples.
- `dist/main.js` — deletes the early-exit `--export` branch that called
  `exportFromFile` headlessly.

`handleExportCommand()` stays as unreachable code to keep the diff minimal.

Pair with `export-public-api` to get `exportSessionToHtml`/`exportFromFile`
on the package index so the extension can reuse the builtin HTML pipeline.

## Why

The builtin `/export` and `--export` load different things (TUI-resolved theme
and tool renderers vs default theme and no renderers). Owning both entry points
in one extension is the only way to make them consistent.

## Testing

```sh
pnpm patches:sync
pnpm install
pnpm test:patches
```

The test verifies `parseArgs` no longer claims `--export` (it becomes an
extension flag value), the builtin list drops `export`, and the interactive
dispatch and `main.js` early-exit branches are gone.
