# Harness 0.2.1-rc.2 compatibility build

This is an independent compatibility build of
[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), based on upstream
commit `6c1d638d1bdcc45ede50fc30249c753d58122a51`. The original author's code,
attribution, license, and prompts are retained. It includes the first compatibility
delivery `d19115cc20fcfb08f1ad3548feef973ee7993e17` and second delivery
`73811c9dd82683b3da450c71f69bbe0c72d146d2`, and third delivery
`690e961d95de7f8c1c2bac5c9a1b90a649c6834d`, plus the cwd template fix below.

Version: `1.1.71-compat.0.2.1rc2.4`.
Delivery branch: `fix/dsh-rc2-cwd-20261018-034944`.

The built-in update, channel-switch, and version-rollback operations are disabled
in this compatibility build: they otherwise install the original upstream code
and remove this fix. The panel explains this when checking for updates. Install
a deliberately selected replacement archive with `dsh plugin ... add` when you
want to change versions. Upstream's existing automatic-update path already does
not update files on startup; that behavior is retained.

## Change and limits

Harness `0.2.1-rc.2` adds a `requiredContexts` set to the final system-prompt
assembly block. Upstream patch 40 does not match this structure, reports it as
skipped, and the subsequent host-content check prevents restart. This build adds
one exact matcher for that published structure and retains the required-context
filter. The old matchers and the restart-readiness checks are unchanged.

The second compatibility build fixes a separate restart race. The sealed Windows
restart path exited the Host after a fixed 1.5 seconds when no runtime service was
available (2 seconds with one). A slow or failed external helper left the old
Electron shell running, which then reported `dsh desktop host stopped`. The Host
now stays alive until the helper stops the application; it does not invoke an
unverified runtime restart service. The helper-owned unpacked restart likewise
does not exit the Host after 250 ms. Async helper/WSH spawn errors are logged.
This does not suppress the desktop shell's real fatal-error reporting.

The PowerShell swap helper writes its own progress and failures to
`%TEMP%\dsh-purge-asar-swap.log`, validates that the archive belongs to the selected
installation, and treats archive-move errors as failures. It checks the move
result before relaunching and logs a failed launch. An API result of `scheduled`
or `restarting` still means dispatch, not verified completion of the new desktop.

The third build fixes the Windows helper launcher. On Windows with Node 24.21.0
and Windows PowerShell 5.1, direct `detached: true` PowerShell startup was reproduced
exiting with code 0 before executing the script, leaving no helper log. Changing
to `detached: false` let the script start, but did not survive parent shutdown in
the isolated probes. The new launcher uses the system `conhost.exe --headless`
with system PowerShell, keeping the window hidden and the console independent.
Both the immediate ASAR swap and the wait-until-idle path use it. Probe scripts
completed after both normal parent exit and forced termination of the test parent.
This console requirement is also discussed in
[Node.js issue 51018](https://github.com/nodejs/node/issues/51018).

Startup output is retained in `%TEMP%\dsh-purge-powershell-launch.log`, with
attempt identifiers, script paths, process creation and launcher exit events.
The launcher's exit code is not a PowerShell-script or desktop-readiness result;
the helper progress log remains necessary. No automatic retry is added. A
synchronous launch failure is no longer marked as an ASAR swap in progress.
PowerShell scripts have unique names and UTF-8 BOMs. No machine execution policy
is changed. This requires a Windows system with headless conhost support; its
presence on the user's other computer has not been measured directly.

The fourth build fixes normal turns failing before the model request with
`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`.
Harness 0.2.1-rc.2 registers `provider` and `model`, and supplies the directory
through `working-directory:current`, a required, literal runtime context.
The plugin bundle and its assembly overlay still added the old
`Your working directory is {{cwd}}.` suffix. Patch status and successful restart
do not validate the later rendering stage, so the earlier checks missed it.

The bundle's default suffix is now empty. The assembly overlay only adds a cwd
template when that assembly actually has its own defined cwd variable. For newer
hosts it removes the exact old directory sentences from persona sections while
preserving surrounding custom text. Literal sections retain `interpolate:false`;
custom unknown variables still fail strict rendering. A custom sentence such as
`My project root is {{cwd}}.` must be removed or supplied with a registered
variable by its contributing plugin; only the old generated clauses are removed
automatically. No global cwd variable or
process-start directory is substituted, and required directory contexts are kept
unchanged so the host can refresh them for each session and model request.
This follows the published
[system-prompt migration guidance](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/system-prompt/README.md#contribute-a-prompt-variable).

Rendering regressions run the actual published `renderPrompt` and context
renderers against the plugin's rewritten assemblies, including modern variables,
legacy cwd variables, custom text, literal brace-containing directory paths and
unknown-variable failures. This verifies the reported prompt-rendering error,
not an authenticated model call on the user's computer.

The fourth delivery passed 104 tests with no skips on Windows x64, Node 24.21.0
and Windows PowerShell 5.1. This includes 25 new renderer regressions. The user
confirmed that the third delivery restarts their desktop successfully; the
fourth delivery's authenticated normal chat still needs validation on that PC.

Offline regression tests cover published 0.2.0-rc.2 and 0.2.1-rc.2 assembly
fragments, required-context behavior, section handling, newline variants,
repeat application, and rejection of unknown context-policy changes. Full
published system-prompt modules are also checked separately during release.
These checks do not establish compatibility of every other upstream patch or
verify the actual Electron desktop restart, ASAR handoff, model response, or
the user's installation. Apply must still pass the normal host checks.
Restart regression tests trap real public API calls before process operations;
Windows helper tests use fake install files and stub process operations. They do
not stop or start a real Harness installation. Native launcher tests run only
benign marker scripts through the real launch API and check output and survival
after the test parent exits; they do not run the real archive swap against an
installed application. The complete Electron restart still needs user validation.

## Install on Windows

1. Confirm the desktop-installed `dsh --version` prints `0.2.1-rc.2`.
2. Finish any running work and fully quit Harness from its system-tray menu.
3. Use that desktop-installed `dsh` to install the supplied archive:

   ```powershell
   dsh plugin --profile desktop add "C:\path\to\dsh-purge-1.1.71-compat.0.2.1rc2.4.tgz"
   ```

   If using a GitHub archive, use the pinned commit URL supplied with the release,
   not a moving branch URL. This updates the same package in the desktop profile;
   do not run the old plugin's Uninstall first. Its Uninstall can remove custom
   prompt and rule files.
4. Open Harness. If you previously disabled dsh-purge in Plugins, enable it.
   When updating an already applied third build, the cwd fix needs only this
   plugin/configuration reload: open a new chat and send an ordinary message.
   It does not require another Clean/Apply operation or a different model.
   If that ordinary message succeeds, the update is complete; skip steps 5-6.
5. For an installation that has not yet applied this compatibility build's host
   patches, open dsh-purge, choose Clean, and Apply. `/purge apply` in the Harness chat is
   also supported, but use the panel first for its desktop CLI repair step.
   A successful apply can restart the desktop app.
6. After restart, create a new chat and run `/purge status`. Patch 40 should be
   applied. If it is skipped, if restart is cancelled, or if the process still
   reports that it cannot read the patched files, preserve the output for
   diagnosis. Do not move, rename, or delete `app.asar` to bypass a failed check.
   If a crash dialog from the old build is still open, choose Exit and fully quit
   before installing this build. Do not use the broad profile-reset recovery
   button as an update step.

## Recovery

If restart does not start, preserve both launch and helper output:

```powershell
Get-Content "$env:TEMP\dsh-purge-powershell-launch.log" -Tail 80
Get-Content "$env:TEMP\dsh-purge-asar-swap.log" -Encoding UTF8 -Tail 80
```

The first file includes native process output, which may use the system code page.
It also records the selected system executable and the exact script path. A
successful launcher exit alone must not be interpreted as a successful restart.

If Apply fails while Harness remains open, `/purge revert` restores available
backups for the currently located host and restores shims; inspect its output
for errors before restarting. It keeps the installed plugin and the user's
prompt file. Disable dsh-purge in the official Plugins page if returning to
ordinary Harness use. This is not a guarantee that every discovered host or
every previous modification is restored.

Do not overwrite or delete the user's `.dsh` directory, chats, custom prompts,
rules, or backups. An application that cannot start needs diagnosis of the
specific failed path and its available backups before further changes.

## Reproduce the focused tests

```sh
node --test tests/*.test.mjs
```

Run the complete suite on Windows with Node 24.21.0 and Windows PowerShell 5.1.
No package installation or running Harness instance is needed. The patch tests
use the pure text replacement API and a mocked assembly function. Updater tests
verify the compatibility guard in isolation. Tests do not locate or patch
installed hosts.
