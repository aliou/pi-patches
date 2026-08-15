# jiti-module-cache -- enable module caching, disable /reload

## What this patch does

1. **Enables jiti module caching** (`moduleCache: true`) in the extension loader. This caches transpiled TypeScript modules between extension loads, significantly speeding up startup when multiple extensions are installed.

2. **Disables `/reload`** by making `handleReloadCommand()` a no-op that shows a warning message. The cache persistence means reloading would serve stale code, so reload is disabled to prevent confusion.

## Why

Without caching, jiti re-transpiles all extension TypeScript files on every startup. With 10+ extensions, this adds 3-7 seconds to startup. The cache is keyed by (file path, mtime), so editing an extension file invalidates only that file's cache.

## Files

- `patch.diff` — unified diff against:
  - `dist/core/extensions/loader.js` — enables moduleCache
  - `dist/modes/interactive/interactive-mode.js` — disables /reload with warning

## Testing

```sh
pnpm patches:sync
pnpm install
pnpm test:patches
```

The test verifies:
- `moduleCache: true` is set in the loader
- `/reload` shows the disabled warning and returns early
- Extension loading still works without errors

## Tradeoffs

- **Startup**: ~50-80% faster extension loading on warm cache
- **Reload**: `/reload` disabled; restart pi to pick up extension changes
- **Memory**: Slightly higher (transpiled modules kept in memory)
