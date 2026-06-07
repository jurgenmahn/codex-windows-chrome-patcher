# Codex Windows Chrome Patcher

Unofficial Windows workaround for enabling the bundled Codex Chrome plugin in Europe or other regions where the Codex desktop app may hide Chrome support behind feature availability checks.

Use this when you want Codex on Windows to connect to the official Codex Chrome Extension and control your existing Chrome browser session.

This repo documents the exact approach we used:

1. Copy the installed Codex app out of `WindowsApps` into a writable folder.
2. Patch `app.asar` in that loose copy so `externalBrowserUse` is enabled.
3. Patch the Electron ASAR integrity hash inside the copied `Codex.exe` (only if that build enforces it).
4. Launch the patched loose copy.
5. Install or reconnect the official Codex Chrome Extension.

## Important Notes

- This is not an official OpenAI tool.
- This is specifically for Windows Codex desktop and Chrome browser use.
- Do not patch the installed `WindowsApps` package in place. Windows AppX packages are signed and protected.
- This patch targets the current minified bundle markers. A Codex update may change those markers and require a script update.
- The patched app copy lives outside the Microsoft Store install and may need to be recreated after Codex updates.

## What This Enables

After the patch works, Codex should advertise both browser backends:

```json
["chrome", "iab"]
```

The Chrome extension popup should show `Connected`, and Codex should be able to see Chrome tabs through the Chrome plugin.

## Requirements

- Windows
- Codex desktop app installed from Microsoft Store
- Node.js available
- `@electron/asar` installed for repacking `app.asar`
- Codex Chrome Extension installed in Chrome

Install the ASAR tool inside this repo:

```powershell
pnpm install
```

## Quick Start

From PowerShell:

```powershell
cd .\codex-windows-chrome-patcher
pnpm install

$source = (Get-ChildItem "C:\Program Files\WindowsApps" -Directory -Filter "OpenAI.Codex_*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$target = "C:\tmp\CodexChromePatched"

Copy-Item -LiteralPath $source -Destination $target -Recurse
node .\scripts\patch-codex-chrome-windows.mjs --app $target --apply --patch-exe-integrity
powershell -ExecutionPolicy Bypass -File .\scripts\launch-patched-codex.ps1 -AppRoot $target
```

If your Codex version folder differs, adjust `$source`. You can find it with:

```powershell
Get-ChildItem "C:\Program Files\WindowsApps" -Directory -Filter "OpenAI.Codex_*"
```

## What Happens When Codex Updates

Microsoft Store updates install a new protected package under `C:\Program Files\WindowsApps`, for example:

```text
OpenAI.Codex_<new-version>_x64__2p2nqsd0c76g0
```

Your loose patched copy, such as `C:\tmp\CodexChromePatched`, is not automatically updated. After a Codex update, one of these will usually be true:

- The Store version has the official feature enabled, and this patch is no longer needed.
- The Store version still hides Chrome, and you need to create a fresh loose copy from the new Store package and patch it again.
- The app bundle changed enough that the script cannot find its markers, and the script must be updated.

Recommended update flow:

1. Close Codex and Chrome.
2. Find the newest `OpenAI.Codex_*` folder under `WindowsApps`.
3. Copy that folder to a new loose path, for example `C:\tmp\CodexChromePatched-<version>`.
4. Run the patcher in `--dry-run` mode first.
5. If all markers are found, run with `--apply --patch-exe-integrity`.
6. Launch the new patched copy.
7. Open Chrome and confirm the extension says `Connected`.
8. Verify Codex can see the Chrome backend before deleting the previous patched copy.

Keep one older working patched copy until the new one is verified.

## Verify

In Codex, ask to use Chrome or run a Chrome-backed check. The expected state is:

- Codex process path is the loose copy, for example `C:\tmp\CodexChromePatched\app\Codex.exe`.
- The Chrome extension popup says `Connected`.
- Codex can list open Chrome tabs.

If the extension says disconnected:

1. Make sure the patched Codex copy is running, not the Store copy.
2. Restart Chrome.
3. Open the extension popup once.
4. Confirm the extension is installed in the Chrome profile you are using.

## Known Limitations

### The "external browser use" toggle in Settings shows OFF again after reopening

This is cosmetic. The patch forces the feature **availability** (so Chrome can be
used) and the runtime feature dispatch, but the Settings toggle reads its checked
state from a separate persisted user setting that the patch does not override.
When you close and reopen Settings, the toggle can therefore appear disabled.

In practice the Chrome backend stays connected and controllable across this: the
extension popup remains `Connected` and Codex can still drive Chrome. Forcing the
displayed toggle to stay on would require patching the persisted-setting read path
as well, which we deliberately left alone to keep the patch minimal and reversible.

### Settings via the Chrome extension

Clicking **Settings** from the Codex Chrome extension popup still opens the normal
Codex settings screen as expected — the patch does not change that navigation.

## Restore / Rollback

For a loose copy, rollback is simple:

```powershell
Remove-Item -LiteralPath "C:\tmp\CodexChromePatched" -Recurse -Force
```

If you used the patch script on another copy and want to restore its `app.asar` from backup:

```powershell
node .\scripts\patch-codex-chrome-windows.mjs --app "C:\tmp\CodexChromePatched" --restore "C:\tmp\CodexChromePatched\app\resources\app.asar.bak-..."
```

## How It Works

Codex ships a bundled Chrome plugin, but the desktop bundle checks feature flags before exposing it. This patch changes the relevant minified feature checks so Chrome browser use is treated as available.

The patch modifies:

- The main Electron bundle feature defaults.
- The main bundle plugin availability predicates.
- The main bundle effective-state objects (so the forced value also flows to the UI).
- The renderer feature dispatch value.
- Optionally, the copied `Codex.exe` embedded ASAR header hash, so Electron accepts the repacked ASAR in a loose copy.

The patcher is resilient to minified-bundle churn between Codex versions:

- Bundle files are located by glob (`main-*.js`, `app-main-*.js`) instead of hardcoded content hashes, so a new build's renamed chunks are still found.
- Markers are matched with regexes that tolerate renamed minified identifiers and operand-order changes, rather than exact string literals.
- The plugin-availability rule neutralizes any `isAvailable` predicate gated on `externalBrowserUseAllowed`, regardless of how many plugins use it or how their arguments are destructured.
- The `Codex.exe` ASAR integrity hash is derived from the pristine `app.asar` (the backup) rather than a hardcoded constant, and is searched/replaced in multiple encodings (UTF-16LE, UTF-8, raw digest). If no embedded integrity hash is present, that step is simply skipped — some Codex builds do not enforce an embedded `app.asar` hash, in which case `--patch-exe-integrity` is unnecessary.
- The exe-integrity step runs **before** `app.asar` is overwritten, so a failure there leaves the loose copy untouched instead of half-patched.
- Each rule is idempotent: it recognizes its already-patched form, so `--apply` can be run again on an already-patched `app.asar` (e.g. after a Codex update) without a prior `--restore`.

## Troubleshooting

### The patch script cannot find markers

Codex updated and the minified JavaScript changed. Extract the new `app.asar`, search for `externalBrowserUse`, and update the markers in `scripts/patch-codex-chrome-windows.mjs`.

### The extension is connected but Codex cannot see Chrome

Restart the patched Codex copy, restart Chrome, then open the extension popup. In our testing, the runtime sometimes needed one extra browser setup retry before the `extension` backend appeared.

### The native host checker says HKCU registry key is missing

If the extension popup says `Connected`, Chrome already found the native host. Some sandboxed checks may read a different HKCU view. Treat the popup plus a running `extension-host.exe` process as stronger evidence.

## Prompt for a Windows Agent

Paste this into a capable local coding agent when Codex updates or when the patch stops applying:

```text
You are working on Windows. The goal is to enable Codex desktop Chrome browser use in Europe or another region-gated install by patching a loose copy of the Codex desktop app. The patch should expose the bundled Codex Chrome plugin so Codex can connect to the official Codex Chrome Extension. Do not modify the protected Microsoft Store package in place.

Safety rules:
- Do not patch files directly under C:\Program Files\WindowsApps.
- Do not delete the previous working patched copy until the new patched copy is verified.
- Do not inspect or export Chrome cookies, passwords, tokens, or local storage.
- Prefer read-only investigation first, then patch a copied loose app directory.

Tasks:
1. Locate the newest installed Codex package:
   Get-ChildItem "C:\Program Files\WindowsApps" -Directory -Filter "OpenAI.Codex_*"
2. Copy that package to a writable loose directory, for example:
   C:\tmp\CodexChromePatched-<version>
3. Install repo dependencies with pnpm install if node_modules is missing.
4. Run:
   node .\scripts\patch-codex-chrome-windows.mjs --app "<loose-copy-path>" --dry-run
5. If dry-run succeeds, run:
   node .\scripts\patch-codex-chrome-windows.mjs --app "<loose-copy-path>" --apply --patch-exe-integrity
6. Launch the patched copy with:
   powershell -ExecutionPolicy Bypass -File .\scripts\launch-patched-codex.ps1 -AppRoot "<loose-copy-path>"
7. Confirm only the patched Codex.exe is running.
8. Start Chrome, open the Codex Chrome Extension popup, and confirm it says Connected.
9. In Codex, verify that browser-use metadata includes chrome and iab, and that the Chrome backend can list open Chrome tabs.

If the patcher fails because markers are missing:
1. Extract the new app.asar to a temporary folder.
2. Search the extracted bundle for externalBrowserUse, externalBrowserUseAllowed, chrome, and bundled plugin availability checks.
3. Identify the new minified equivalents of:
   - externalBrowserUse default false flags
   - externalBrowserUseAllowed checks around Chrome plugin availability
   - renderer feature dispatch for externalBrowserUse
4. Update scripts/patch-codex-chrome-windows.mjs with the new exact markers.
5. Re-run dry-run, then apply only after all markers are found.
6. Document the new Codex version and marker changes in the README.

Expected result:
- Codex request metadata advertises ["chrome", "iab"].
- agent.browsers.list() includes a browser named Chrome with type extension.
- The official Codex Chrome Extension popup says Connected.
```

## Files

- `scripts/patch-codex-chrome-windows.mjs`: patches a Codex app copy.
- `scripts/launch-patched-codex.ps1`: closes Store Codex processes and launches the patched copy.
