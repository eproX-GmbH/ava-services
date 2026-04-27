# Ollama bundled binaries (D7)

This directory is populated at package time by `scripts/fetch-ollama.mjs`.
Layout:

```
resources/ollama/
  darwin-arm64/ollama        ← macOS Apple Silicon
  darwin-x64/ollama          ← macOS Intel
  linux-x64/ollama           ← Linux x86_64
  win32-x64/ollama.exe       ← Windows x86_64
```

`electron-builder.yml`'s `extraResources` block copies the whole tree into
the packaged app's `Resources/ollama/`. The runtime supervisor
(`src/main/ollama-supervisor.ts`) discovers the right binary via
`process.platform`-`process.arch`.

## Refreshing

```sh
pnpm fetch:ollama                          # all platforms, default version
OLLAMA_VERSION=v0.3.14 pnpm fetch:ollama   # pin a version
pnpm fetch:ollama --platform=darwin-arm64  # one platform only
```

The script is idempotent: it skips downloads when the on-disk `.version`
file matches `OLLAMA_VERSION`.

## Why not use the user's installed Ollama?

Per [DECISIONS.md §D7](../../../../DECISIONS.md):

- First-run UX without an extra install step
- The app pins a tested Ollama version
- Auto-update can ship a new Ollama alongside the rest of the bundle

A development build with no fetched binary falls back to a system-PATH
`ollama` (so you can still run `pnpm dev` without 4×20MB downloads); a
packaged build does not — it shows the FirstRunWizard error screen if the
bundled binary is missing.
