# export-public-api -- export the HTML session export pipeline

## What this patch does

Adds the HTML export pipeline to the package's public index:

- `dist/index.js` / `dist/index.d.ts` — exports `exportSessionToHtml`,
  `exportFromFile`, and the `ExportOptions` / `ToolHtmlRenderer` types from
  `core/export-html`.

## Why

`/export` (via `AgentSession.exportToHtml`) and `--export` (via `exportFromFile`)
both build on these functions, but nothing exported them from the package index,
so an extension could not reuse the builtin pipeline (template, theme vars,
export colors, tool pre-rendering). Combined with `disable-export-command`, an
extension can own the `/export` command and the `--export` flag and drive both
through the same code with the same theme resolution:

```ts
import { exportSessionToHtml } from "@earendil-works/pi-coding-agent";

const themeName = /* resolved from settings, matching the TUI */;
await exportSessionToHtml(sessionManager, state, { outputPath, themeName });
```

## Testing

```sh
pnpm patches:sync
pnpm install
pnpm test:patches
```

The test imports both functions from the package index and runs `exportFromFile`
against a small session fixture to confirm it produces an HTML file.
