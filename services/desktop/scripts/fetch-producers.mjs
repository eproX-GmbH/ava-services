#!/usr/bin/env node
// Vendor producer services for bundling (Phase 8.v1.1).
//
// AVA's Plan-B architecture (see AGENT_PLAN 8.v) runs the per-tenant
// producer services (company-profile, structured-content,
// company-publication, company-evaluation, company-contact) as
// Node subprocesses spawned by the desktop main process. They speak
// AMQP to CloudAMQP and SQL to the bundled PGlite gateway. To make
// that possible, each producer's compiled JS + production-only
// node_modules need to live inside the .dmg / .exe.
//
// This script does that vendoring at build time:
//
//   1. For each producer in PRODUCERS:
//      - cd into the workspace dir (../../<name>)
//      - run `npm run build` so dist/ is current
//      - copy dist/ + prisma/ + package.json into
//        services/desktop/resources/producers/<name>/
//      - run `npm install --omit=dev --no-package-lock` inside the
//        copy so node_modules holds only runtime deps + the prisma
//        CLI (we keep prisma so `prisma migrate deploy` can run on
//        first launch against the user's PGlite database)
//
//   2. The desktop's `ProducerSupervisor` resolves
//      `<resourcesPath>/producers/<name>/dist/web/api/server.js` at
//      runtime in packaged mode, or
//      `<repoRoot>/<name>/dist/web/api/server.js` in dev. Spawned
//      with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` so the
//      bundled Electron acts as a plain Node interpreter.
//
// Idempotent: the destination dir's `node_modules/.package-lock.json`
// presence flips it into a no-op. Delete the dir to force a re-vendor.
//
// Caveat — npm registry auth: producers depend on `@ava/event` and
// `@ava/auth` from the GitLab npm registry. The producer's `.npmrc`
// is also copied into the staging dir before `npm install` so the
// existing NPM_TOKEN env var is honoured. CI must export NPM_TOKEN
// before running this script (the workflow already does for
// db-gateway / master-data).

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..", "..");
const RESOURCES_ROOT = join(DESKTOP_ROOT, "resources", "producers");

// Producer manifest. Keep the entry list ordered by dispatch chain
// (master-data → structured-content → company-profile → ...) so the
// bundle ordering stays predictable and a partial CI run still
// vendors the upstream-most producer first.
//
// `entry` is the path inside the producer's own dist/ tree; it's
// what `node` is invoked on at runtime. `databaseName` is the
// PGlite database the producer talks to — the supervisor injects
// this into DATABASE_URL.
const PRODUCERS = [
  {
    name: "company-profile",
    workspaceDir: "company-profile",
    entry: "dist/web/api/server.js",
    databaseName: "company_profile",
  },
  // Phase 8.v1.4 — remaining tenant-private producers.
  // Same shape, same vendor pipeline; each gets its own PGlite
  // database under userData/pglite/<name>/.
  {
    name: "structured-content",
    workspaceDir: "structured-content",
    entry: "dist/web/api/server.js",
    databaseName: "structured_content",
  },
  {
    name: "company-publication",
    workspaceDir: "company-publication",
    entry: "dist/web/api/server.js",
    databaseName: "company_publication",
  },
  {
    name: "company-evaluation",
    workspaceDir: "company-evaluation",
    entry: "dist/web/api/server.js",
    databaseName: "company_evaluation",
  },
  {
    name: "company-contact",
    workspaceDir: "company-contact",
    entry: "dist/web/api/server.js",
    databaseName: "company_contact",
  },
  {
    // §8.v3 pivot-2 — website moves local. Uses operator-paid
    // valueserp via the gateway proxy (key never leaves fly).
    name: "website",
    workspaceDir: "website",
    entry: "dist/web/api/server.js",
    databaseName: "website",
  },
];

const argv = process.argv.slice(2);
const onlyName = argv
  .find((a) => a.startsWith("--name="))
  ?.split("=")[1];

async function main() {
  const targets = onlyName
    ? PRODUCERS.filter((p) => p.name === onlyName)
    : PRODUCERS;
  if (targets.length === 0) {
    throw new Error(`No matching producer for --name=${onlyName}`);
  }

  mkdirSync(RESOURCES_ROOT, { recursive: true });

  for (const target of targets) {
    const srcDir = join(REPO_ROOT, target.workspaceDir);
    const dstDir = join(RESOURCES_ROOT, target.name);
    const sentinel = join(dstDir, "node_modules", ".package-lock.json");
    // v0.1.164 — content-aware skip. Pre-v0.1.164 used the bare
    // presence of `node_modules/.package-lock.json` as "already
    // vendored, skip". CI re-runs that picked up an updated producer
    // submodule (esp. the vendored @ava/ai-provider's OAuth-token
    // branch from v0.1.145) silently SKIPPED the rebuild and shipped
    // stale `dist/index.js` to users. Hash the producer source +
    // vendor tree + package.json; store the digest alongside the
    // sentinel. Skip only when the recorded digest matches the
    // current source. Local devs benefit too: a `git pull` that
    // touches a producer triggers a fresh vendor on the next run.
    const sourceFingerprint = computeSourceFingerprint(srcDir);
    const fingerprintFile = join(dstDir, ".vendor-fingerprint");

    // Submodule may not be checked out (e.g. CI without
    // SUBMODULES_PAT, or the submodule wasn't added to the workflow's
    // init allowlist). Submodule placeholders leave an empty dir
    // behind, so check for `package.json` rather than dir existence.
    // Soft-skip the producer instead of crashing the whole run — the
    // bundle ships without this producer and the desktop's
    // ProducerSupervisor degrades gracefully ("not vendored").
    if (!existsSync(join(srcDir, "package.json"))) {
      console.warn(
        `[producers] ${target.name}: source dir at ${srcDir} has no package.json — submodule not checked out, skipping`,
      );
      continue;
    }

    if (existsSync(sentinel) && existsSync(fingerprintFile)) {
      const recorded = readFileSync(fingerprintFile, "utf8").trim();
      if (recorded === sourceFingerprint) {
        console.log(
          `[producers] ${target.name}: already vendored, fingerprint matches → skipping`,
        );
        continue;
      }
      console.log(
        `[producers] ${target.name}: fingerprint mismatch (was ${recorded.slice(0, 8)}, now ${sourceFingerprint.slice(0, 8)}) → re-vendoring`,
      );
      rmSync(dstDir, { recursive: true, force: true });
    } else if (existsSync(sentinel)) {
      // Sentinel present but no fingerprint file → built by a pre-
      // v0.1.164 version of this script. Force re-vendor once to
      // record the current fingerprint, then future runs cache.
      console.log(
        `[producers] ${target.name}: legacy sentinel without fingerprint → re-vendoring once`,
      );
      rmSync(dstDir, { recursive: true, force: true });
    }

    // Build OUTSIDE the workspace. The producers' tsconfigs don't set
    // `skipLibCheck`, so building inside the monorepo causes tsc to
    // typecheck workspace-hoisted .d.ts files (zod 4.x, etc.) that
    // weren't there at the time the producer's TS version was
    // pinned. Same reason the production Docker images do `npm ci`
    // in a clean container.
    //
    // Staging directory: a sibling of dstDir under
    // <userHome>/.cache/ava-producer-build/<name>. Survives across
    // runs of this script so subsequent invocations don't re-pay the
    // npm install cost.
    const stageDir = join(
      process.env.HOME ?? "/tmp",
      ".cache",
      "ava-producer-build",
      target.name,
    );
    mkdirSync(stageDir, { recursive: true });

    // 1. Mirror the producer source into the stage dir, omitting the
    //    workspace-polluted node_modules and any dist from a prior
    //    build. cp -a behaviour via cpSync.
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    for (const entry of [
      "package.json",
      "tsconfig.json",
      "tsconfig.build.json",
      "src",
      "prisma",
      // v0.1.74 — mirror `vendor/` so `file:./vendor/ai-provider`
      // resolves to a local path inside the staging dir. Previously
      // we relied on the rewrite-to-absolute-source-path trick below,
      // which worked for company-profile + website but kept resolving
      // to a stale registry tarball for company-contact in CI (no
      // root cause confirmed; npm's file: + package-lock interaction
      // is the prime suspect). Copying vendor side-steps the whole
      // class of bugs because the file: dep now points at content
      // that npm has direct, in-staging-tree access to.
      "vendor",
    ]) {
      const from = join(srcDir, entry);
      if (existsSync(from)) {
        cpSync(from, join(stageDir, entry), { recursive: true });
      }
    }
    if (existsSync(join(srcDir, "package-lock.json"))) {
      cpSync(
        join(srcDir, "package-lock.json"),
        join(stageDir, "package-lock.json"),
      );
    }
    if (existsSync(join(srcDir, ".npmrc"))) {
      cpSync(join(srcDir, ".npmrc"), join(stageDir, ".npmrc"));
    }

    // 2. Strip lifecycle scripts that aren't applicable to a vendored
    //    install (husky, tests). Prisma stays a *dev* dependency:
    //    we only need the CLI at vendor time (for `prisma generate`),
    //    not at runtime — the desktop's ProducerSupervisor applies
    //    migrations directly via the `pg` driver against PGlite,
    //    bypassing `prisma migrate deploy` entirely. Dropping prisma
    //    from runtime saves ~50 MB per producer in the .dmg.
    const stagePkgPath = join(stageDir, "package.json");
    const pkg = JSON.parse(readFileSync(stagePkgPath, "utf8"));
    if (pkg.scripts) {
      delete pkg.scripts.prepare;
      delete pkg.scripts.test;
      delete pkg.scripts["test:unit"];
      delete pkg.scripts["test:functional"];
    }

    // v0.1.99 — strip the same lifecycle scripts from every staged
    // file: vendor dep BEFORE npm install. Without this, npm runs
    // `prepare: tsc` on the linked vendor, which rebuilds the
    // vendor's dist from its (often stale) committed src. Across
    // company-contact / company-profile / website the vendor src
    // had drifted behind the committed dist after we synced new
    // exports earlier; the rebuild silently dropped getCurrentTier /
    // getCurrentModel and the producer's compute-worker failed to
    // import them. Fix is independent of vendor freshness — never
    // run prepare on linked file: deps. The committed dist is
    // canonical.
    const stagedVendorRoot = join(stageDir, "vendor");
    if (existsSync(stagedVendorRoot)) {
      try {
        const vendorEntries = readdirSync(stagedVendorRoot, { withFileTypes: true });
        for (const e of vendorEntries) {
          if (!e.isDirectory()) continue;
          const vendorPkgPath = join(stagedVendorRoot, e.name, "package.json");
          if (!existsSync(vendorPkgPath)) continue;
          const vendorPkg = JSON.parse(readFileSync(vendorPkgPath, "utf8"));
          if (vendorPkg.scripts) {
            delete vendorPkg.scripts.prepare;
            delete vendorPkg.scripts.postinstall;
            delete vendorPkg.scripts.preinstall;
            delete vendorPkg.scripts.install;
            writeFileSync(vendorPkgPath, JSON.stringify(vendorPkg, null, 2));
          }
        }
      } catch (err) {
        console.warn(
          `[producers] failed to strip lifecycle scripts from staged vendor:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    // Resolve file: deps that pointed at workspace siblings — the
    // staging dir is outside the monorepo so `file:../packages/foo`
    // doesn't resolve. Rewrite them to the absolute workspace path
    // so npm install copies the built package into stage's
    // node_modules.
    //
    // ALSO: hoist the file-dep's own dependencies into the producer's
    // dependencies. npm's install-from-tarball path is flaky about
    // transitive deps — the company-profile bundle silently shipped
    // without `openai`, `@ai-sdk/*`, etc. that ai-provider needs at
    // runtime, leading to `Cannot find module 'openai'` at first
    // import. Promoting them to top-level deps forces npm to put
    // them in node_modules where the require chain finds them.
    if (pkg.dependencies) {
      for (const [k, v] of Object.entries(pkg.dependencies)) {
        if (typeof v === "string" && v.startsWith("file:")) {
          const rel = v.slice("file:".length);
          // v0.1.76 — keep the original RELATIVE path when the staged
          // copy exists. Rewriting to absolute caused npm 10 to flag a
          // package.json-vs-lockfile mismatch (lockfile entries for
          // file: deps store the relative path) and fall back to
          // re-resolving from the registry — which silently grabbed an
          // OLDER published @ava/ai-provider missing the v0.1.65
          // helpers. Result: company-contact's tsc failed on
          // getCurrentTier / getCurrentModel.
          //
          // For file: deps OUTSIDE the producer dir (only
          // company-evaluation's `file:../packages/ai-provider`) the
          // staged copy can't exist, so we still rewrite to the
          // absolute source path as a fallback.
          const stageCandidate = join(stageDir, rel);
          let fileDepPkgPath;
          if (existsSync(stageCandidate)) {
            // Path stays exactly as the lockfile remembers it.
            fileDepPkgPath = join(stageCandidate, "package.json");
          } else {
            const abs = resolve(srcDir, rel);
            pkg.dependencies[k] = `file:${abs}`;
            fileDepPkgPath = join(abs, "package.json");
          }
          if (existsSync(fileDepPkgPath)) {
            const fileDepPkg = JSON.parse(
              readFileSync(fileDepPkgPath, "utf8"),
            );
            for (const [depName, depVer] of Object.entries(
              fileDepPkg.dependencies ?? {},
            )) {
              // Don't overwrite producer's own pinned versions —
              // they win for any conflicts.
              if (!pkg.dependencies[depName]) {
                pkg.dependencies[depName] = depVer;
              }
            }
          }
        }
      }
    }

    // Force zod 4 as a top-level dep + an `overrides` block.
    //   - @ai-sdk/provider-utils@3 (transitive via @ai-sdk/openai)
    //     requires `zod/v4` (a sub-path export only present in zod 4)
    //   - openai@4 has zod 3 as an optional peer, which under
    //     --legacy-peer-deps caused npm to skip installing zod
    //     entirely. Result: provider-utils crashes at boot with
    //     "Cannot find module 'zod/v4'".
    // Pinning zod top-level + overriding it everywhere ensures
    // every dep that walks node_modules/zod/ finds v4.
    pkg.dependencies = pkg.dependencies ?? {};
    if (!pkg.dependencies.zod) {
      pkg.dependencies.zod = "^4.0.0";
    }
    pkg.overrides = pkg.overrides ?? {};
    pkg.overrides.zod = "^4.0.0";
    writeFileSync(stagePkgPath, JSON.stringify(pkg, null, 2));

    // 3. Inject `skipLibCheck: true` into the build tsconfig. The
    //    producer's own deps drag in zod 4.x which uses TS-5.4+
    //    syntax; the producer's pinned TS version chokes on those
    //    .d.ts files. fly's Docker build is uniformly TS-aligned so
    //    the issue doesn't bite there. Patching skipLibCheck here
    //    matches the standard "trust transitive types in prod
    //    builds" posture and doesn't weaken the source typecheck.
    const stageTsconfigPath = join(stageDir, "tsconfig.build.json");
    if (existsSync(stageTsconfigPath)) {
      const ts = JSON.parse(readFileSync(stageTsconfigPath, "utf8"));
      ts.compilerOptions = ts.compilerOptions ?? {};
      ts.compilerOptions.skipLibCheck = true;
      writeFileSync(stageTsconfigPath, JSON.stringify(ts, null, 2));
    }

    // 4. Full install in the stage dir (dev deps included so tsc /
    //    tsc-alias can run). NPM_TOKEN must be set — producers
    //    depend on @ava/event from the GitLab npm registry.
    console.log(`[producers] ${target.name}: npm install (stage)…`);
    // --legacy-peer-deps: needed because @ava/ai-provider's deps
    // include both zod 4.x (via ai SDK 5) and `openai` (which has
    // zod 3.x as an optional peer). Default npm v7+ peer-dep
    // resolution rejects this. The conflict is harmless at runtime
    // — both zod versions coexist fine in node_modules.
    runSyncStrict(
      "npm",
      ["install", "--no-audit", "--no-fund", "--legacy-peer-deps"],
      { cwd: stageDir },
    );

    // 4b. Override TypeScript to a version that can parse the
    //     transitive .d.ts files we'll see in node_modules. The
    //     producers pin TS 4.8.x, which predates zod 4.x's
    //     declaration syntax (`extends infer T extends ...`); even
    //     `skipLibCheck` doesn't help because TS 4.8's parser bails
    //     before the type-check phase. Bumping to 5.6 in the stage
    //     leaves the source repo untouched and matches what
    //     ESlint/Prisma already expect.
    runSyncStrict(
      "npm",
      [
        "install",
        "--save-dev",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
        "typescript@5.6",
      ],
      { cwd: stageDir },
    );

    // 4a. Generate the Prisma client BEFORE the TypeScript build.
    //     The producer's tsconfig has `paths: {"@prisma/client":
    //     ["generated/prisma-client"]}` so tsc resolves imports of
    //     `@prisma/client` against the generated dir — which doesn't
    //     exist yet. macOS happened to dodge this because
    //     `@prisma/client`'s own postinstall hook can auto-run
    //     `prisma generate` if it finds schema.prisma, but on Windows
    //     CI that hook is unreliable (different shell, different exec
    //     bits) and tsc fails with "Module '@prisma/client' has no
    //     exported member …". Running prisma generate up-front fixes
    //     the order regardless of platform-specific install hooks.
    //
    //     We still need to keep the prisma CLI around BEFORE prune
    //     --omit=dev (it's a devDep), so generation stays in this
    //     pre-prune window.
    console.log(`[producers] ${target.name}: prisma generate…`);
    runSyncStrict("npx", ["prisma", "generate"], { cwd: stageDir });

    // 4b. Build into stage/dist.
    console.log(`[producers] ${target.name}: npm run build…`);
    runSyncStrict("npm", ["run", "build"], { cwd: stageDir });

    // 5a2. Rebuild native modules against Electron's Node ABI.
    //      Producers ship native deps (node-expat, sharp, etc.).
    //      `npm install` builds them for whatever Node ABI is on
    //      PATH (115 = Node 20, 127 = Node 22). Electron 31 ships
    //      its own Node patched with ABI 125 — so a CI-built bundle
    //      crashes at first import with
    //        Error: The module '...node_expat.node' was compiled
    //        against NODE_MODULE_VERSION 115; this version requires 125
    //      `@electron/rebuild` walks the stage's node_modules and
    //      recompiles each native dep against the target Electron
    //      version's ABI.
    //
    //      Find @electron/rebuild via the desktop's own node_modules
    //      (it's a workspace devDep we install at vendor time).
    // Resolve electron-rebuild bin: pnpm with `node-linker=hoisted`
    // puts the binary at the workspace root's node_modules/.bin,
    // not at services/desktop/. Walk both.
    const candidateBins = [
      resolve(DESKTOP_ROOT, "node_modules", ".bin", "electron-rebuild"),
      resolve(REPO_ROOT, "node_modules", ".bin", "electron-rebuild"),
    ];
    const electronRebuildBin = candidateBins.find((p) => existsSync(p));
    const electronVersion = readElectronVersion();
    if (electronRebuildBin && electronVersion) {
      console.log(
        `[producers] ${target.name}: electron-rebuild for v${electronVersion}…`,
      );
      runSyncStrict(
        electronRebuildBin,
        ["--version", electronVersion, "--module-dir", stageDir],
        { cwd: stageDir },
      );
    } else {
      console.warn(
        `[producers] ${target.name}: electron-rebuild missing (looked at ${candidateBins.join(" + ")}) — native modules may crash at runtime.`,
      );
    }

    // 5b. tsc-alias quirk workaround.
    //     The producer's tsconfig has
    //       "@prisma/client": ["generated/prisma-client"]
    //     against baseUrl ".". tsc-alias rewrites every
    //       import { PrismaClient } from "@prisma/client";
    //     to literally `require("..")` in the emitted JS — which
    //     from dist/infrastructure/ resolves to dist/, where there
    //     is no package.json or index.js. Without a bridge, the
    //     producer crashes at startup with
    //       Cannot find module '..'
    //     Drop a tiny dist/index.js that re-exports the prisma
    //     client. Cheap, isolated, idempotent.
    const distIndex = join(stageDir, "dist", "index.js");
    if (!existsSync(distIndex)) {
      writeFileSync(
        distIndex,
        `// Auto-generated by services/desktop/scripts/fetch-producers.mjs.
// Bridge for tsc-alias's degenerate \`@prisma/client\` -> \`..\`
// rewrite. Do not edit.
"use strict";
module.exports = require("../generated/prisma-client");
`,
      );
    }

    // 5c. Trim to runtime: drop dev deps. Prisma CLI goes away here
    //     (we don't need it at runtime — the desktop applies
    //     migrations via raw SQL through the `pg` driver). The
    //     generated/ dir we just produced stays untouched because
    //     it's outside node_modules.
    console.log(`[producers] ${target.name}: npm prune --omit=dev…`);
    runSyncStrict(
      "npm",
      ["prune", "--omit=dev", "--legacy-peer-deps"],
      { cwd: stageDir },
    );

    // 5b. Trim node_modules to the actually-needed shape. Runtime
    //     producers don't need:
    //       - swagger-ui-dist  (~11 MB) — /api-docs route, headless
    //       - gpt-tokenizer's esm/ + dist/ rollups (the producer is
    //         CJS, only cjs/ is loaded at runtime; saves ~25 MB)
    //       - source maps (.map) anywhere (recoverable from the
    //         workspace if a stack trace ever needs them)
    //       - upstream test fixtures (tests/, __tests__/, examples/)
    //       - LICENSE / README / CHANGELOG noise (pure cosmetic for
    //         a vendored bundle the user never opens)
    //     Kept on purpose: prisma CLI + @prisma/engines (both with
    //     darwin binary) — needed for `migrate deploy` at first
    //     launch. We accept the duplicate 18 MB cost there.
    console.log(`[producers] ${target.name}: trimming node_modules…`);
    trimNodeModules(join(stageDir, "node_modules"));
    //    We keep dist + node_modules + prisma + package.json.
    rmSync(dstDir, { recursive: true, force: true });
    mkdirSync(dstDir, { recursive: true });
    // Copy `generated/` too — the producer schema.prisma sets
    //   `output = "../generated/prisma-client"`
    // so tsc-alias rewrites `import "@prisma/client"` to a relative
    // path into `generated/prisma-client`, NOT into node_modules.
    // Without this, the bundled producer crashes at first import
    // with `Cannot find module '..'` (tsc-alias collapsed the
    // missing dir away).
    // Required entries throw when missing; optional entries are
    // copied if present and silently skipped otherwise. `generated/`
    // is optional because not every producer overrides Prisma's
    // default output dir.
    const REQUIRED = ["dist", "node_modules", "prisma", "package.json"];
    const OPTIONAL = ["generated"];
    for (const entry of [...REQUIRED, ...OPTIONAL]) {
      const from = join(stageDir, entry);
      if (!existsSync(from)) {
        if (OPTIONAL.includes(entry)) continue;
        throw new Error(
          `[producers] ${target.name}: stage missing ${entry} after build`,
        );
      }
      // dereference: true replaces every symlink with its target.
      // Required because the vendored tree gets packaged into the
      // macOS .app bundle, and `codesign --deep --strict` rejects
      // symlinks pointing outside the bundle ("invalid destination
      // for symbolic link"). npm install creates lots of these
      // under node_modules/.bin/ and as hoist trampolines. Cost is
      // a few extra MB of duplication; correctness >> size here.
      cpSync(from, join(dstDir, entry), {
        recursive: true,
        dereference: true,
      });
    }

    // 7. Drop the .npmrc copy — it might carry a token-bearing line,
    //    and check-bundle-secrets.mjs would (rightly) fail the
    //    build. The producer's runtime never needs it.
    const npmrc = join(dstDir, ".npmrc");
    if (existsSync(npmrc)) {
      rmSync(npmrc, { force: true });
    }

    // v0.1.164 — record the source fingerprint so subsequent runs
    // can skip when nothing changed AND re-build when source moves.
    writeFileSync(fingerprintFile, sourceFingerprint, "utf8");

    console.log(`[producers] ${target.name}: done → ${dstDir}`);
  }
}

/**
 * v0.1.164 — Compute a stable digest over the producer's source tree
 * + its vendored deps. We walk src/, vendor/, package.json,
 * tsconfig*.json, package-lock.json (and the submodule's git HEAD if
 * present) and hash the concatenated path+size+mtime tuples. Cheap
 * enough on a few thousand files; deterministic across CI runs as
 * long as the working tree doesn't change.
 *
 * NOT a perfect content hash — we hash mtimes not file bytes — but
 * that's fine for "did anything change since last vendor" because
 * git checkout updates mtimes and a submodule bump rewrites every
 * touched file. False-negatives (unchanged content, new mtime) just
 * trigger an extra rebuild; false-positives (changed content, same
 * mtime + size) require a malicious actor and are out of scope.
 */
function computeSourceFingerprint(srcDir) {
  const ROOTS = ["src", "vendor", "prisma", "generated"];
  const TOP_FILES = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
  ];
  const hash = createHash("sha256");
  for (const f of TOP_FILES) {
    const p = join(srcDir, f);
    if (!existsSync(p)) continue;
    const s = statSync(p);
    hash.update(`${f}|${s.size}|${s.mtimeMs.toFixed(0)}\n`);
  }
  for (const root of ROOTS) {
    const dir = join(srcDir, root);
    if (!existsSync(dir)) continue;
    walkSorted(dir, dir, hash);
  }
  return hash.digest("hex");
}

function walkSorted(rel, absRoot, hash) {
  const stack = [rel];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Sort for deterministic iteration order across filesystems.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const full = join(dir, ent.name);
      // Skip node_modules — it's regenerated by `npm install` and its
      // mtimes are basically random per CI run; including it makes
      // the fingerprint useless for caching.
      if (ent.name === "node_modules") continue;
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          const s = statSync(full);
          const relPath = full.slice(absRoot.length + 1);
          hash.update(`${relPath}|${s.size}|${s.mtimeMs.toFixed(0)}\n`);
        } catch {
          // unreadable — skip
        }
      }
    }
  }
}

/**
 * Aggressive but safe trim of a vendored node_modules tree. Only
 * touches files/dirs that are well-known noise for headless
 * server runtime — never anything that could plausibly be required
 * at first import.
 */
function trimNodeModules(nmDir) {
  if (!existsSync(nmDir)) return;

  // Whole packages we drop entirely.
  // - prisma: the CLI. Survived `npm prune --omit=dev` because it's a
  //   peer dep of @prisma/client. We don't run `prisma migrate` /
  //   `prisma generate` at runtime — migrations are applied by the
  //   desktop's ProducerSupervisor via raw SQL through `pg`. Saves ~29 MB.
  //
  // NOT dropped (despite headless producer): swagger-ui-dist. The
  // producer's dist/web/api/app.js eagerly require()s
  // swagger-ui-express, which in turn require()s swagger-ui-dist
  // at module load time — so even though /api-docs is never served
  // to a real user, dropping the dep makes the producer crash at
  // boot. ~11 MB cost, accept it.
  const dropPackages = ["prisma"];
  for (const name of dropPackages) {
    const p = join(nmDir, name);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
    }
  }

  // Drop non-target-platform binaries from packages that ship
  // pre-built native modules for every OS. We only ship to the
  // host platform per build; carrying win32 + linux blobs in a
  // mac DMG (and vice-versa) is pure dead weight.
  //
  // - onnxruntime-node: ~174 MB savings on darwin-arm64
  //   (drops bin/napi-v6/linux/ + bin/napi-v6/win32/)
  // - @img/sharp-*: per-platform packages; keep darwin or win32
  //   depending on host
  const hostPlatform = process.platform;
  const onnxBin = join(
    nmDir,
    "onnxruntime-node",
    "bin",
    "napi-v6",
  );
  if (existsSync(onnxBin)) {
    for (const platDir of ["darwin", "linux", "win32"]) {
      if (platDir === hostPlatform) continue;
      const p = join(onnxBin, platDir);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
  }
  const imgDir = join(nmDir, "@img");
  if (existsSync(imgDir)) {
    let imgEntries;
    try {
      imgEntries = readdirSync(imgDir, { withFileTypes: true });
    } catch {
      imgEntries = [];
    }
    for (const e of imgEntries) {
      if (!e.isDirectory()) continue;
      // sharp packages are named e.g. `sharp-darwin-arm64`,
      // `sharp-linux-x64`, `sharp-libvips-win32-x64`. Match the host
      // platform substring; everything else gets dropped.
      const platMatch =
        (hostPlatform === "darwin" && e.name.includes("darwin")) ||
        (hostPlatform === "win32" && e.name.includes("win32")) ||
        (hostPlatform === "linux" && e.name.includes("linux"));
      if (!platMatch) {
        rmSync(join(imgDir, e.name), { recursive: true, force: true });
      }
    }
  }

  // Inside @prisma/engines, drop the schema-engine-darwin binary (~20 MB)
  // — it's the migrate engine, only needed by `prisma migrate deploy`
  // which we no longer call. The query engine stays (used by
  // @prisma/client at runtime).
  const enginesDir = join(nmDir, "@prisma", "engines");
  if (existsSync(enginesDir)) {
    for (const f of [
      "schema-engine-darwin",
      "schema-engine-darwin-arm64",
      "schema-engine-linux-musl",
      "schema-engine-windows.exe",
    ]) {
      const p = join(enginesDir, f);
      if (existsSync(p)) rmSync(p, { force: true });
    }
  }

  // Remove dangling symlinks under .bin/ — npm wired these to the
  // packages we just dropped. The downstream cpSync({dereference:true})
  // would error on them.
  const dotBin = join(nmDir, ".bin");
  if (existsSync(dotBin)) {
    let entries;
    try {
      entries = readdirSync(dotBin, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      const p = join(dotBin, e.name);
      if (e.isSymbolicLink()) {
        // existsSync returns false for symlinks pointing at missing
        // targets — perfect "dangling?" check.
        if (!existsSync(p)) {
          try {
            rmSync(p, { force: true });
          } catch {
            /* fine */
          }
        }
      }
    }
  }

  // gpt-tokenizer ships dist/ + cjs/ + esm/ + src/ — runtime only
  // needs cjs/. Saves ~25 MB.
  const gptTok = join(nmDir, "gpt-tokenizer");
  if (existsSync(gptTok)) {
    for (const sub of ["esm", "dist", "src"]) {
      const p = join(gptTok, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
  }

  // Walk every package dir and strip noise files. We do it once at
  // the top level rather than per-pkg-config so a freshly-added
  // dep gets the same hygiene without code change.
  walkAndStrip(nmDir);
}

function walkAndStrip(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // Drop top-level junk dirs that are common across packages.
      if (
        e.name === "test" ||
        e.name === "tests" ||
        e.name === "__tests__" ||
        e.name === "examples" ||
        e.name === "docs" ||
        e.name === ".github" ||
        e.name === "coverage"
      ) {
        rmSync(p, { recursive: true, force: true });
        continue;
      }
      walkAndStrip(p);
    } else if (e.isFile()) {
      // Drop source maps, TypeScript sources alongside compiled JS,
      // and assorted text noise. Also: standalone *.test.js fixtures
      // that ship inside dist/ — they trip our bundle-secret audit
      // with placeholder credentials and have no runtime purpose.
      if (
        e.name.endsWith(".map") ||
        e.name.endsWith(".test.js") ||
        e.name.endsWith(".test.cjs") ||
        e.name.endsWith(".test.mjs") ||
        e.name.endsWith(".spec.js") ||
        e.name === "CHANGELOG.md" ||
        e.name === "HISTORY.md" ||
        e.name === ".eslintrc" ||
        e.name === ".eslintrc.js" ||
        e.name === ".eslintrc.json" ||
        e.name === ".prettierrc" ||
        e.name === ".npmignore" ||
        e.name === ".gitattributes"
      ) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* fine */
        }
      }
    }
  }
}

/**
 * Read the Electron version pinned in services/desktop/package.json.
 * Used as the target ABI for `electron-rebuild` so native modules
 * inside the producer bundle match what Electron loads at runtime.
 */
function readElectronVersion() {
  // Prefer the version pinned in electron-builder.yml since that's
  // what actually ships in the .dmg. Fall back to package.json
  // (which may carry a caret/tilde range like "^31.0.0").
  const yamlPath = join(DESKTOP_ROOT, "electron-builder.yml");
  if (existsSync(yamlPath)) {
    const text = readFileSync(yamlPath, "utf8");
    const m = text.match(/^electronVersion:\s*"?(\d+\.\d+\.\d+)"?/m);
    if (m) return m[1];
  }
  const pkgPath = join(DESKTOP_ROOT, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const v =
      pkg.devDependencies?.electron ??
      pkg.dependencies?.electron ??
      null;
    if (!v) return null;
    return v.replace(/^[\^~]/, "");
  } catch {
    return null;
  }
}

function runSyncStrict(cmd, args, opts) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    // Windows needs shell:true so spawn finds .cmd / .bat files
    // (npm, npx, prisma, …) without manual path resolution. On
    // POSIX the shell wrapper is harmless but slightly slower.
    shell: process.platform === "win32",
    ...opts,
    env: { ...process.env, ...(opts?.env ?? {}) },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
