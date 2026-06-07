#!/usr/bin/env node
// Patches a loose Codex copy to expose the bundled Chrome plugin.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const WINDOWS_APPS = "C:\\Program Files\\WindowsApps";
const PACKAGE_SUFFIX = "_x64__2p2nqsd0c76g0";
const ORIGINAL_ASAR_HEADER_HASH =
  "0914b5a1cd66a81962edb46e3f8ac49bc574144a4460ec55ff46010273eda9fd";

// Electron bakes its fuse configuration into the main binary as a known
// sentinel string followed by [wireVersion, fuseCount, ...stateBytes]. The
// asar header hash only needs patching when EnableEmbeddedAsarIntegrityValidation
// is ON; newer Codex builds ship it OFF (and embed no hash at all).
const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const FUSE_ASAR_INTEGRITY_INDEX = 4; // EnableEmbeddedAsarIntegrityValidation

function findLatestCodexApp() {
  if (!existsSync(WINDOWS_APPS)) return null;
  let entries;
  try {
    entries = readdirSync(WINDOWS_APPS);
  } catch {
    // WindowsApps listing is often ACL-denied (EPERM). Auto-detect simply
    // fails in that case; the caller can still pass --app explicitly.
    return null;
  }
  const candidates = entries
    .filter((name) => name.startsWith("OpenAI.Codex_") && name.endsWith(PACKAGE_SUFFIX))
    .map((name) => join(WINDOWS_APPS, name))
    .filter((path) => existsSync(join(path, "app", "resources", "app.asar")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function localAsarTool() {
  return join(process.cwd(), "node_modules", "@electron", "asar", "bin", "asar.mjs");
}

function usage() {
  console.log(`Usage:
  node scripts/patch-codex-chrome-windows.mjs [--app PATH] [--asar PATH] [--node PATH] [--work PATH] [--dry-run] [--apply] [--patch-exe-integrity]
  node scripts/patch-codex-chrome-windows.mjs --restore BACKUP_PATH [--app PATH]

Defaults:
  --app   CODEX_APP_ROOT env var, or latest OpenAI.Codex package under WindowsApps
  --asar  ASAR_BIN env var, or ./node_modules/@electron/asar/bin/asar.mjs
  --node  NODE_EXE env var, or app/resources/node.exe

Use this on a copied loose Codex app directory, not the protected WindowsApps package.`);
}

function parseArgs(argv) {
  const app = process.env.CODEX_APP_ROOT || findLatestCodexApp();
  const opts = {
    app,
    asar: process.env.ASAR_BIN || localAsarTool(),
    node: process.env.NODE_EXE || null,
    work: null,
    dryRun: false,
    apply: false,
    restore: null,
    patchExeIntegrity: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--patch-exe-integrity") opts.patchExeIntegrity = true;
    else if (arg === "--restore") opts.restore = argv[++i];
    else if (arg.startsWith("--restore=")) opts.restore = arg.slice("--restore=".length);
    else if (arg === "--app") opts.app = argv[++i];
    else if (arg.startsWith("--app=")) opts.app = arg.slice("--app=".length);
    else if (arg === "--asar") opts.asar = argv[++i];
    else if (arg.startsWith("--asar=")) opts.asar = arg.slice("--asar=".length);
    else if (arg === "--node") opts.node = argv[++i];
    else if (arg.startsWith("--node=")) opts.node = arg.slice("--node=".length);
    else if (arg === "--work") opts.work = argv[++i];
    else if (arg.startsWith("--work=")) opts.work = arg.slice("--work=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (opts.app == null) throw new Error("Could not auto-detect Codex app. Pass --app PATH.");
  opts.app = resolve(opts.app);
  opts.node ??= join(opts.app, "app", "resources", "node.exe");

  if (opts.dryRun && opts.apply) throw new Error("Use either --dry-run or --apply, not both.");
  if (!opts.apply) opts.dryRun = true;
  return opts;
}

function asarHeaderHash(asarPath) {
  const buffer = readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(12);
  return createHash("sha256").update(buffer.subarray(16, 16 + headerSize)).digest("hex");
}

function readAsarHeader(asarPath) {
  const buffer = readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(12);
  return JSON.parse(buffer.toString("utf8", 16, 16 + headerSize));
}

function collectUnpackedFiles(node, parts, acc) {
  if (node == null || typeof node !== "object") return acc;
  if (node.files && typeof node.files === "object") {
    for (const [name, child] of Object.entries(node.files)) {
      collectUnpackedFiles(child, [...parts, name], acc);
    }
  } else if (node.unpacked === true && !("link" in node)) {
    acc.push(parts.join("\\"));
  }
  return acc;
}

// asar's extractAll reads EVERY unpacked file (native .node bindings live in
// <asar>.unpacked) and aborts with ENOENT if even one is missing. Newer Codex
// builds ship a header that references optional natives (e.g. serialport) that
// aren't on disk. Those are irrelevant to the Chrome-plugin patch, so drop a
// zero-byte placeholder for each missing one so extract can proceed, and return
// the paths so the caller can remove them afterward (leaving the install as it
// was). The bundles we patch live INSIDE the asar, never in .unpacked.
function healMissingUnpacked(asarPath) {
  const unpackedRoot = `${asarPath}.unpacked`;
  if (!existsSync(unpackedRoot)) return [];
  const header = readAsarHeader(asarPath);
  const created = [];
  for (const rel of collectUnpackedFiles(header, [], [])) {
    const onDisk = join(unpackedRoot, rel);
    if (existsSync(onDisk)) continue;
    mkdirSync(dirname(onDisk), { recursive: true });
    writeFileSync(onDisk, Buffer.alloc(0));
    created.push(onDisk);
  }
  return created;
}

// The expected app.asar header hash is embedded in Codex.exe. Depending on the
// Electron/Windows build it can be stored as ASCII hex, UTF-16LE hex (PE
// resources are wide), or the raw 32-byte SHA-256 digest. Encode each candidate
// hash the same way for searching and replacing so byte lengths stay equal.
function encodeHash(hexHash, encoding) {
  if (encoding === "hex") return Buffer.from(hexHash, "hex"); // raw 32 bytes
  return Buffer.from(hexHash, encoding); // "utf8" | "utf16le"
}

// Read the EnableEmbeddedAsarIntegrityValidation fuse from whichever app binary
// carries the Electron fuse wire (Codex.exe on older builds, chrome.dll on
// newer ones). Returns { state: "on"|"off"|"removed"|"unknown", file }.
function readAsarIntegrityFuse(appRoot) {
  const sentinel = Buffer.from(FUSE_SENTINEL, "ascii");
  const appDir = join(appRoot, "app");
  const preferred = [join(appDir, "Codex.exe"), join(appDir, "chrome.dll")];
  const rest = walkFiles(appDir, (_full, name) => /\.(exe|dll)$/i.test(name));
  const seen = new Set();
  for (const file of [...preferred, ...rest]) {
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const buf = readFileSync(file);
    const at = buf.indexOf(sentinel);
    if (at < 0) continue;
    let p = at + sentinel.length;
    const wireVersion = buf[p++];
    const count = buf[p++];
    if (FUSE_ASAR_INTEGRITY_INDEX >= count) return { state: "unknown", file };
    const v = buf[p + FUSE_ASAR_INTEGRITY_INDEX];
    const state = v === 0x31 ? "on" : v === 0x30 ? "off" : v === 0x72 ? "removed" : "unknown";
    return { state, file, wireVersion, count };
  }
  return { state: "unknown", file: null };
}

function patchExeAsarIntegrity(appRoot, oldHash, newHash) {
  const exePath = join(appRoot, "app", "Codex.exe");
  const exe = readFileSync(exePath);
  // Derived original first, then historical hardcoded constant (older builds).
  const hashCandidates = [oldHash, ORIGINAL_ASAR_HEADER_HASH].filter(Boolean);
  const encodings = ["utf16le", "utf8", "hex"];

  let idx = -1;
  let usedOld = null;
  let usedEnc = null;
  for (const candidate of hashCandidates) {
    for (const enc of encodings) {
      const needle = encodeHash(candidate, enc);
      const at = exe.indexOf(needle);
      if (at >= 0) {
        if (exe.indexOf(needle, at + 1) >= 0) {
          throw new Error(`Hash ${candidate} (${enc}) appears multiple times in ${exePath}`);
        }
        idx = at;
        usedOld = candidate;
        usedEnc = enc;
        break;
      }
    }
    if (idx >= 0) break;
  }

  if (idx < 0) {
    throw new Error(
      `Original ASAR header hash not found in ${exePath}.\n` +
        `Tried hashes [${hashCandidates.join(", ")}] in encodings [${encodings.join(", ")}].`,
    );
  }

  const before = encodeHash(usedOld, usedEnc);
  const after = encodeHash(newHash, usedEnc);
  if (before.length !== after.length) {
    throw new Error(`Hash length mismatch (${usedEnc}): ${usedOld} vs ${newHash}`);
  }
  after.copy(exe, idx);
  writeFileSync(exePath, exe);
  return { exePath, oldHash: usedOld, newHash, encoding: usedEnc };
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function walkFiles(dir, predicate, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, acc);
    else if (predicate(full, entry.name)) acc.push(full);
  }
  return acc;
}

// Codex ships hashed bundle names (main-XXXX.js, app-main-XXXX.js) that change
// every build. Resolve them dynamically instead of hardcoding the hash.
function findBundle(root, subdirParts, prefix) {
  const dir = join(root, ...subdirParts);
  const matches = walkFiles(
    dir,
    (_full, name) => name.startsWith(prefix) && name.endsWith(".js"),
  );
  if (matches.length === 0) {
    throw new Error(
      `Could not locate ${prefix}*.js under ${dir}. Codex bundle layout may have changed.`,
    );
  }
  // Prefer the largest file (the real bundle, not a tiny chunk/sourcemap shim).
  matches.sort((a, b) => statSync(b).size - statSync(a).size);
  return matches[0];
}

// Regex-based replace so minified identifier churn (lt, Yn, Jn, d, e, t...) does
// not break the patch. Each rule must match exactly once.
// `patchedRegex` makes a rule idempotent: if the original marker is gone but the
// already-patched form is present, the rule counts as satisfied instead of
// missing. This lets --apply run again on an already-patched asar without a
// prior --restore. Pass a non-global regex as the sentinel.
function replaceRegex(text, regex, replacement, label, changes, patchedRegex = null) {
  const found = text.match(regex);
  if (!found) {
    if (patchedRegex && patchedRegex.test(text)) {
      changes.changed.push(`${label} (already patched)`);
      return text;
    }
    changes.missing.push(label);
    return text;
  }
  if (found.length > 1) {
    changes.missing.push(`${label} (ambiguous: ${found.length} matches)`);
    return text;
  }
  changes.changed.push(label);
  return text.replace(regex, replacement);
}

// Like replaceRegex but expects one or more matches (e.g. multiple plugin
// availability predicates that all need neutralizing). Also idempotent via
// `patchedRegex`.
function replaceAllRegex(text, regex, replacement, label, changes, patchedRegex = null, minCount = 1) {
  const found = text.match(regex);
  const count = found ? found.length : 0;
  if (count < minCount) {
    if (count === 0 && patchedRegex && patchedRegex.test(text)) {
      changes.changed.push(`${label} (already patched)`);
      return text;
    }
    changes.missing.push(`${label} (found ${count}, expected >= ${minCount})`);
    return text;
  }
  changes.changed.push(`${label} (x${count})`);
  return text.replace(regex, replacement);
}

function dumpContext(text, needle, label, changes) {
  const i = text.indexOf(needle);
  if (i < 0) return;
  const snippet = text.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, " ");
  changes.context.push(`${label}: ...${snippet}...`);
}

function patchMain(root) {
  const file = findBundle(root, [".vite", "build"], "main-");
  const changes = { file, changed: [], missing: [], context: [] };
  let text = readFileSync(file, "utf8");

  // 1) Default feature flags: externalBrowserUse / externalBrowserUseAllowed.
  text = replaceRegex(
    text,
    /externalBrowserUse:!1,externalBrowserUseAllowed:!1/g,
    "externalBrowserUse:!0,externalBrowserUseAllowed:!0",
    "main default external browser availability",
    changes,
    /externalBrowserUse:!0,externalBrowserUseAllowed:!0/,
  );

  // 2) Plugin availability predicates. Neutralize ANY isAvailable arrow that
  // gates on externalBrowserUseAllowed, regardless of destructure shape
  // ({features:e} vs {buildFlavor:e,env:t,features:n}), minified flavor-check
  // name, or operand order. Expect >=1 (chrome plugin + helper plugin).
  text = replaceAllRegex(
    text,
    /isAvailable:\([^)]*\)=>[^}]*?externalBrowserUseAllowed[^}]*?(?=\})/g,
    "isAvailable:()=>!0",
    "main external browser plugin availability",
    changes,
    /isAvailable:\(\)=>!0/,
  );

  // 3) Effective-state objects: the settings UI re-reads the persisted value on
  // reopen and copies it over the forced default. Force those reads to true so
  // the toggle stays enabled across settings open/close.
  //   ...externalBrowserUse:o.externalBrowserUse,externalBrowserUseAllowed:o.externalBrowserUseAllowed
  text = replaceAllRegex(
    text,
    /externalBrowserUse:(\w+)\.externalBrowserUse,externalBrowserUseAllowed:\1\.externalBrowserUseAllowed/g,
    "externalBrowserUse:!0,externalBrowserUseAllowed:!0",
    "main effective external browser state (allowed pair)",
    changes,
    /externalBrowserUse:!0,externalBrowserUseAllowed:!0/,
  );
  //   ...externalBrowserUse:n.externalBrowserUse,inAppBrowserUse:n.inAppBrowserUse
  text = replaceAllRegex(
    text,
    /externalBrowserUse:(\w+)\.externalBrowserUse,inAppBrowserUse:\1\.inAppBrowserUse/g,
    "externalBrowserUse:!0,inAppBrowserUse:$1.inAppBrowserUse",
    "main effective external browser state (inApp pair)",
    changes,
    /externalBrowserUse:!0,inAppBrowserUse:\w+\.inAppBrowserUse/,
  );

  if (changes.missing.length > 0) {
    dumpContext(text, "externalBrowserUseAllowed", "main externalBrowserUseAllowed", changes);
    dumpContext(text, "isAvailable:", "main isAvailable", changes);
  }

  writeFileSync(file, text);
  return changes;
}

function patchRenderer(root) {
  const file = findBundle(root, ["webview", "assets"], "app-main-");
  const changes = { file, changed: [], missing: [], context: [] };
  let text = readFileSync(file, "utf8");

  // Renderer feature dispatch: externalBrowserUse:<x>.available,...:<x>.allowed
  text = replaceRegex(
    text,
    /externalBrowserUse:(\w+)\.available,externalBrowserUseAllowed:\1\.allowed/g,
    "externalBrowserUse:!0,externalBrowserUseAllowed:!0",
    "renderer desktop feature dispatch external browser",
    changes,
    /externalBrowserUse:!0,externalBrowserUseAllowed:!0/,
  );

  if (changes.missing.length > 0) {
    dumpContext(text, "externalBrowserUse:", "renderer externalBrowserUse", changes);
  }

  writeFileSync(file, text);
  return changes;
}

function assertAllMarkersFound(results) {
  const missing = results.flatMap((result) => result.missing.map((label) => `${label} in ${result.file}`));
  if (missing.length > 0) {
    const context = results.flatMap((result) => result.context ?? []);
    const ctxBlock = context.length > 0 ? `\n\nNearby source context for updating markers:\n${context.map((c) => `- ${c}`).join("\n")}` : "";
    throw new Error(`Patch markers missing:\n${missing.map((item) => `- ${item}`).join("\n")}${ctxBlock}`);
  }
}

function patchTree(root) {
  const results = [patchMain(root), patchRenderer(root)];
  assertAllMarkersFound(results);
  return results;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const appRoot = resolve(opts.app);
  const asarPath = join(appRoot, "app", "resources", "app.asar");

  if (opts.restore != null) {
    const backup = resolve(opts.restore);
    if (!existsSync(backup)) throw new Error(`Missing backup: ${backup}`);
    cpSync(backup, asarPath);
    console.log(`Restored ${asarPath} from ${backup}`);
    return;
  }

  const work = opts.work == null ? join("C:\\tmp", `codex-chrome-patch-${Date.now()}`) : resolve(opts.work);
  for (const required of [asarPath, opts.asar, opts.node]) {
    if (!existsSync(required)) throw new Error(`Missing required path: ${required}`);
  }

  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  mkdirSync(dirname(work), { recursive: true });
  const placeholders = healMissingUnpacked(asarPath);
  if (placeholders.length > 0) {
    console.warn(
      `Note: ${placeholders.length} unpacked file(s) referenced by the asar header are missing on disk ` +
        `(optional natives, unrelated to the Chrome plugin). Using empty placeholders to allow extraction:\n` +
        placeholders.map((p) => `  - ${p}`).join("\n"),
    );
  }
  try {
    run(opts.node, [opts.asar, "extract", asarPath, work]);
  } finally {
    for (const placeholder of placeholders) rmSync(placeholder, { force: true });
  }

  const results = patchTree(work);
  console.log(JSON.stringify({ mode: opts.apply ? "apply" : "dry-run", appRoot, work, results }, null, 2));

  if (!opts.apply) {
    console.log("Dry run complete. Extracted patched tree left in place; app.asar was not changed.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${asarPath}.bak-${stamp}`;
  const packed = join("C:\\tmp", `codex-chrome-patched-${stamp}.asar`);
  run(opts.node, [opts.asar, "pack", work, packed]);

  // Patch the exe FIRST (against the still-pristine asar), so a failure here
  // leaves app.asar untouched and avoids a broken half-patched state.
  // oldHash = header hash of the current (pristine) asar at asarPath,
  // newHash = header hash of the freshly packed/patched asar.
  let exePatch = null;
  if (opts.patchExeIntegrity) {
    const fuse = readAsarIntegrityFuse(appRoot);
    if (fuse.state === "off" || fuse.state === "removed") {
      console.log(
        `Embedded ASAR integrity validation is ${fuse.state} ` +
          `(Electron fuse in ${fuse.file}); skipping exe integrity patch — not needed for this build.`,
      );
    } else {
      if (fuse.state === "unknown") {
        console.warn(
          "Could not read the ASAR integrity fuse; attempting exe patch anyway.",
        );
      }
      exePatch = patchExeAsarIntegrity(appRoot, asarHeaderHash(asarPath), asarHeaderHash(packed));
    }
  }

  cpSync(asarPath, backup);
  cpSync(packed, asarPath);

  // The extraction work dir and temp packed asar are only needed up to this
  // copy; remove them so repeated --apply runs don't litter C:\tmp. The backup
  // next to app.asar is kept. (Dry-run returns earlier and leaves work in place
  // for inspection.)
  rmSync(work, { recursive: true, force: true });
  rmSync(packed, { force: true });

  console.log(`Applied patch. Backup: ${backup}`);
  if (exePatch != null) {
    console.log(`Patched Electron ASAR integrity in ${exePatch.exePath} (${exePatch.encoding}): ${exePatch.oldHash} -> ${exePatch.newHash}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

