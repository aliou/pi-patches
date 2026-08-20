# tree-entry-timestamps -- always show entry times in the /tree view

## What this patch does

`dist/modes/interactive/components/tree-selector.js` — in `TreeList.render()`,
prepend a muted, formatted timestamp (from the entry's own `timestamp` field) to
every rendered row, after the tree structure prefix and before the label/content.

The added `formatEntryTimestamp()` renders:

- entries from today: `HH:MM (<relative>)`, e.g. `15:57 (2h ago)`
  (`now`, `Nm ago`, or `Nh ago`)
- older entries: ISO 8601 `YYYY-MM-DD HH:MM`, e.g. `2020-05-13 14:23`

## Why

The tree view hides when each entry happened. Branches that forked hours or
days apart look identical, which makes picking the right branch in `/tree` a
guessing game. The data (`entry.timestamp`) and the formatter were already
there; only the render path ignored them for non-label rows.

The label-time toggle (`app.tree.toggleLabelTimestamp`) is unchanged and stays
independent: it controls the optional `[label]` timestamps only.

## Testing

```sh
pnpm patches:sync
pnpm install
pnpm test:patches
```

The test imports the patched `tree-selector.js` from `node_modules`, builds a
two-entry tree, renders it, and asserts each row shows the formatted
`HH:MM` entry time. It fails on the unpatched package.
