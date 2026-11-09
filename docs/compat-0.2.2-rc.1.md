# Harness 0.2.2-rc.1 compatibility build

Version: `1.1.71-compat.0.2.2rc1.2`.
Branch: `fix/dsh-rc1-cli-backup-20261109-104515`.
Base: the complete previous delivery, commit
`7c4b89e5d9e674cc2a45175ec96836c6404a9e90`.
The original author, source, prompts and licenses from
[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) are retained.
The previous [cwd and Windows restart fixes](compat-0.2.1-rc.2.md) remain included.

## Problem and resulting behavior

The second 0.2.2 build fixes the reported Host crash during Apply:
`ENOENT ... rename ... dsh.cmd.dsh-purge.bak.<pid>.<time>.copytmp`.
The synchronous CLI repair API started `atomicCopyFile` without awaiting or
handling its Promise, then immediately changed the launcher. Any later copy
failure escaped the surrounding synchronous catch and terminated the Host.
Millisecond-only temporary names also collided during concurrent copies; this
was independently reproduced with ENOENT and EBUSY in a disposable directory.

CLI repair now completes a synchronous atomic backup before changing a launcher.
Official `resources/runtime/cli/bin` directories are recognized as sealed
command directories, so backups use the external `dsh-purge/shim-backups` path.
Existing legacy backups are retained and preferred when an external backup is
first created. A backup failure returns an error report, leaves the launcher
unchanged and stops the sealed-host preparation before restart. No backup
Promise is left running. Atomic copy/write helpers use UUID temporary names and
remove their own partial files on failure.

Tests cover same-millisecond concurrent copy/write operations, actual CLI repair
against a disposable desktop layout, backup ordering, repeat repair, preserving
legacy/existing backups, failed backup and rename, and partial disk-full writes.
They never execute the fixture application.

The published `@deepseek-ai/dsh-system-prompt@0.2.2-rc.1` restores provider-owned
`tools` after the prompt waterfall in both the ordinary and complete-prompt
returns. The older patch 40 does not match this block, so the later host-content
check fails and Apply can cancel restart with the host-not-written message.

This build adds one exact matcher for the complete published block. It preserves
provider-owned tools, the required-context filter, custom prompt sections and
the previous complete-prompt section handling. Unknown changes to the tools or
required-context rules do not match. The original older matchers are retained;
no restart check is bypassed or relaxed.

The target source is the public npm package, verified against its registry
SHA-512 integrity. Its complete system-prompt module also matches the inspected
Windows desktop build `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8` byte for byte.
The full-module SHA-256 is
`18b692b03bbb717589085f63b126cbcf22963763c5a0565bb3a7a5d254e8e4a7`.
Fixture provenance is recorded in [the fixtures README](../tests/fixtures/README.md).

## Validation and limits

The tests execute the real text patcher against literal published assembly
fragments for 0.2.0-rc.2, 0.2.1-rc.2 and 0.2.2-rc.1. They cover complete and
ordinary prompts, suppression with required contexts, immutable inputs,
duplicate sections, LF/CRLF, repeat application, and different tool lists or
missing tools returned by waterfall listeners. Provider tools remain intact in
all 0.2.2 modes. Unrecognized tool/context policies remain unmatched.

Existing strict-rendering, cwd, updater and Windows restart regressions remain
part of the suite. All 130 tests passed with no skips on Windows x64 and Node
24.21.0. The ten CLI-backup tests also passed under the installed Electron
44.7.0 / Node 24.21.0, exercising its real original-fs routing with disposable
files. The native launcher regression now waits for redirected console output
to flush and for fixture directory handles to be released before cleanup.
A separate local check of the first 0.2.2 build loaded the real bundled Cordis 4.1.0 and the
complete 0.2.2-rc.1 SystemPrompt module with an in-process source hook. Its four
ordinary/complete and context-suppression combinations passed actual assembly,
strict rendering, provider-tool retention and dynamic directory refresh checks.
The patched full module passed the host-content check and repeat application.
This local check did not change installed files or call an account/model API.

Desktop-source text matching and JavaScript parsing are
offline checks; they do not establish compatibility of every optional patch,
an authenticated model response, or every Windows installation.

## Windows installation

Use this package with Harness `0.2.2-rc.1`. Finish current work before restarting
the application. The package has startup auto-apply disabled; installing it
does not itself apply host-file patches or schedule an application restart.

If `dsh` is on PATH:

```powershell
dsh plugin --profile desktop add "C:\full\path\dsh-purge-1.1.71-compat.0.2.2rc1.2-full-source.tgz"
```

Otherwise the installed official launcher can be addressed directly:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\full\path\dsh-purge-1.1.71-compat.0.2.2rc1.2-full-source.tgz"
```

Open Harness and its dsh-purge panel. For a first installation, Apply performs
the host-file patching and can restart the desktop. Preserve its error output
if it fails; do not manually delete or rename `app.asar` to force the check.
After a successful restart, open a new chat and send an ordinary message as
well as checking `/purge status`. Status alone does not validate rendering or
the model request.

Built-in upstream updating, channel switching and rollback remain disabled for
compatibility builds to prevent overwriting these fixes. Replace this package
deliberately with an identified compatible version when upgrading Harness.
Do not uninstall first: upstream uninstall can remove custom prompts or rules.

## Reproduce

```sh
node --test --test-reporter=spec tests/*.test.mjs
```

The release validation environment is Windows x64, Node 24.21.0 and Windows
PowerShell 5.1. Tests operate on fixtures, disposable files and harmless launcher
marker scripts; they do not modify a real Harness installation.
