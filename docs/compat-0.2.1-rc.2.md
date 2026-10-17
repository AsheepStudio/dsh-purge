# Harness 0.2.1-rc.2 compatibility build

This is an independent compatibility build of
[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge), based on upstream
commit `6c1d638d1bdcc45ede50fc30249c753d58122a51`. The original author's code,
attribution, license, prompts, and existing patch behavior are retained.

Version: `1.1.71-compat.0.2.1rc2.1`.

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

Offline regression tests cover published 0.2.0-rc.2 and 0.2.1-rc.2 assembly
fragments, required-context behavior, section handling, newline variants,
repeat application, and rejection of unknown context-policy changes. Full
published system-prompt modules are also checked separately during release.
These checks do not establish compatibility of every other upstream patch or
verify the actual Electron desktop restart, ASAR handoff, model response, or
the user's installation. Apply must still pass the normal host checks.

## Install on Windows

1. Confirm the desktop-installed `dsh --version` prints `0.2.1-rc.2`.
2. Finish any running work and fully quit Harness from its system-tray menu.
3. Use that desktop-installed `dsh` to install the supplied archive:

   ```powershell
   dsh plugin --profile desktop add "C:\path\to\dsh-purge-1.1.71-compat.0.2.1rc2.1.tgz"
   ```

   If using a GitHub archive, use the pinned commit URL supplied with the release,
   not a moving branch URL. This updates the same package in the desktop profile;
   do not run the old plugin's Uninstall first. Its Uninstall can remove custom
   prompt and rule files.
4. Open Harness. If you previously disabled dsh-purge in Plugins, enable it.
5. Open dsh-purge, choose Clean, and Apply. `/purge apply` in the Harness chat is
   also supported, but use the panel first for its desktop CLI repair step.
   A successful apply can restart the desktop app.
6. After restart, create a new chat and run `/purge status`. Patch 40 should be
   applied. If it is skipped, if restart is cancelled, or if the process still
   reports that it cannot read the patched files, preserve the output for
   diagnosis. Do not move, rename, or delete `app.asar` to bypass a failed check.

## Recovery

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

No package installation or running Harness instance is needed. The patch tests
use the pure text replacement API and a mocked assembly function. Updater tests
verify the compatibility guard in isolation. Tests do not locate or patch
installed hosts.
