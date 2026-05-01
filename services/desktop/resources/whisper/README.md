# Whisper.cpp bundled binaries (Phase 8.n1)

This directory is populated at package time by `scripts/fetch-whisper.mjs`.
Layout:

```
resources/whisper/
  darwin-arm64/whisper-cli   ← macOS Apple Silicon
  darwin-x64/whisper-cli     ← macOS Intel
  linux-x64/whisper-cli      ← Linux
  win32-x64/whisper-cli.exe  ← Windows
```

`electron-builder.yml`'s `extraResources` block copies these into the
packaged app's `<resourcesPath>/whisper/<platform>-<arch>/`.

The model GGUF (~756 MB Distil-Whisper-DE Q4_0) is **not** bundled. The
desktop downloads it post-install via the `voice:downloadModel` IPC and
stores it under `userData/whisper/<modelId>.bin`. See
`src/main/voice/whisper-sidecar.ts`.

To fetch the binaries locally:

```sh
pnpm fetch:whisper                       # all platforms
pnpm fetch:whisper --platform=darwin-arm64
WHISPER_CPP_VERSION=v1.7.4 pnpm fetch:whisper
```

The platform sub-folders are gitignored — committing 100 MB binaries
into Git would be ridiculous. CI runs the fetch step before
`electron-builder` (see `package.json` `package:*` scripts).
