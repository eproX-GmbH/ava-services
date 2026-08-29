#!/usr/bin/env node
// C4 — Wrapper für die Chart-Spec-Tests (6 valid + 6 invalid + 8KB-Cap).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inner = join(here, "_test-chart-spec.inner.mjs");

// v0.1.446 — tsx raus: Node >= 22.6 strippt TS-Typen nativ, und der
// tsx-Loader lieferte unter Node 24 ein Modul OHNE Named-Exports
// ("does not provide an export named 'parseAndValidate'"). Der native
// Pfad ist verifiziert und braucht keine Dev-Dependency.
const res = spawnSync(process.execPath, [inner], {
  stdio: "inherit",
  cwd: root,
});
process.exit(res.status ?? 1);
