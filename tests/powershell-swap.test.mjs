import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Decode only the production constant's JSON-compatible string literals. Never
// import desktop.js, discover a host, or evaluate arbitrary repository code.
function productionHelper() {
  const source = fs.readFileSync(new URL("../lib/desktop.js", import.meta.url), "utf8");
  const match = source.match(/^const ASAR_SWAP_PS1 = \[\r?\n([\s\S]*?)^\]\.join\("\\r\\n"\);/m);
  assert.ok(match, "the actual ASAR_SWAP_PS1 literal array must be present");
  return match[1].trim().split(/\r?\n/).map((line) => {
    const literal = line.trim();
    assert.match(literal, /^"(?:[^"\\]|\\.)*",$/, "only string literals may be decoded");
    return JSON.parse(literal.slice(0, -1));
  }).join("\r\n");
}

const harness = String.raw`param(
  [string]$HelperPath,
  [string]$FixtureRoot,
  [string]$FixtureMode,
  [string]$TargetAsar,
  [string]$FixtureExe
)
$ErrorActionPreference = 'Stop'
$global:PurgeFixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
$global:PurgeFixtureExe = [IO.Path]::GetFullPath($FixtureExe)
$global:PurgeFixtureAsar = Join-Path (Join-Path (Split-Path -Parent $PurgeFixtureExe) 'resources') 'app.asar'
$global:PurgeFixtureMode = $FixtureMode
$global:PurgeFixtureAudit = Join-Path $PurgeFixtureRoot 'audit.jsonl'
$global:PurgeFixtureLog = Join-Path $env:TEMP 'dsh-purge-asar-swap.log'

function Write-FixtureAudit([string]$Op, $Detail) {
  $row = @{ op = $Op; detail = $Detail } | ConvertTo-Json -Compress -Depth 5
  Microsoft.PowerShell.Management\Add-Content -LiteralPath $PurgeFixtureAudit -Value $row -Encoding UTF8
}
function Assert-FixturePath([string]$Actual, [string]$Expected) {
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($Actual), [IO.Path]::GetFullPath($Expected))) {
    throw ('Fixture rejected path: ' + $Actual)
  }
}
function global:Get-CimInstance {
  [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName)
  Write-FixtureAudit 'Get-CimInstance' $ClassName
  # Synthetic process records only. The unrelated record must never be stopped.
  [pscustomobject]@{ ExecutablePath = $PurgeFixtureExe; ProcessId = 1040000001 }
  [pscustomobject]@{ ExecutablePath = (Join-Path (Split-Path -Parent $PurgeFixtureExe) 'runtime\node.exe'); ProcessId = 1040000002 }
  [pscustomobject]@{ ExecutablePath = (Join-Path $PurgeFixtureRoot 'unrelated\other.exe'); ProcessId = 1040000003 }
}
function global:Get-Process {
  [CmdletBinding()] param([int]$Id, [string[]]$Name)
  Write-FixtureAudit 'Get-Process' @{ id = $Id; names = $Name }
  # No actual process lookup; report that fixture processes have already stopped.
}
function global:Stop-Process {
  [CmdletBinding()] param([int[]]$Id, [switch]$Force)
  foreach ($item in $Id) {
    if ($item -notin @(1040000001, 1040000002)) { throw 'Unexpected synthetic process ID' }
    Write-FixtureAudit 'Stop-Process' $item
  }
}
function global:Start-Process {
  [CmdletBinding()] param([string]$FilePath)
  Assert-FixturePath $FilePath $PurgeFixtureExe
  Write-FixtureAudit 'Start-Process' @{ path = $FilePath; errorAction = [string]$PSBoundParameters['ErrorAction'] }
  if ($PurgeFixtureMode -eq 'launch-failure') { Write-Error 'fixture launch rejected'; return }
  # Never invoke the native Start-Process command.
}
function global:Start-Sleep {
  [CmdletBinding()] param([int]$Milliseconds, [int]$Seconds)
  Write-FixtureAudit 'Start-Sleep' @{ milliseconds = $Milliseconds; seconds = $Seconds }
}
function global:robocopy.exe {
  param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Arguments)
  Assert-FixturePath ([string]$Arguments[0]) ($PurgeFixtureAsar + '.unpacked')
  Assert-FixturePath ([string]$Arguments[1]) (Join-Path (Split-Path -Parent $PurgeFixtureAsar) 'app')
  Write-FixtureAudit 'robocopy.exe' $Arguments
  $global:LASTEXITCODE = 0
  # No external executable is launched and no native files are copied.
}
function global:Move-Item {
  [CmdletBinding()] param([string]$LiteralPath, [string]$Destination, [switch]$Force)
  Assert-FixturePath $LiteralPath $PurgeFixtureAsar
  Assert-FixturePath $Destination ($PurgeFixtureAsar + '.bak')
  Write-FixtureAudit 'Move-Item' @{ source = $LiteralPath; destination = $Destination; errorAction = [string]$PSBoundParameters['ErrorAction'] }
  if ($PurgeFixtureMode -eq 'move-failure') {
    # Deliberately nonterminating unless the real helper passes -ErrorAction Stop.
    Write-Error 'fixture nonterminating move failure'
    return
  }
  if ($PurgeFixtureMode -eq 'move-noop') { return }
  Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
}
function global:Remove-Item {
  [CmdletBinding()] param([string]$LiteralPath, [Parameter(Position=0)][string]$Path, [switch]$Force)
  if ($Path -eq 'Env:ELECTRON_RUN_AS_NODE') {
    Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
    return
  }
  if ($Path) { throw 'Unexpected nonliteral removal' }
  if ($LiteralPath -notin @(($PurgeFixtureAsar + '.bak'), ($PurgeFixtureAsar + '.rename-pending'))) {
    throw 'Removal outside exact fixture files'
  }
  Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
}
function global:Add-Content {
  [CmdletBinding()] param([string]$LiteralPath, [object[]]$Value, [string]$Encoding)
  Assert-FixturePath $LiteralPath $PurgeFixtureLog
  Microsoft.PowerShell.Management\Add-Content @PSBoundParameters
}
function global:Set-Content {
  [CmdletBinding()] param([string]$LiteralPath, [object[]]$Value, [string]$Encoding)
  Assert-FixturePath $LiteralPath ($PurgeFixtureAsar + '.rename-pending')
  Microsoft.PowerShell.Management\Set-Content @PSBoundParameters
}

# Refuse future helper changes that could bypass the process-operation mocks.
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HelperPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'The production helper has PowerShell syntax errors' }
$allowed = @('Join-Path','Add-Content','Get-Date','Write-RestartLog','Split-Path',
  'Get-CimInstance','Where-Object','ForEach-Object','Stop-Process','Stop-HarnessInstall',
  'Start-Sleep','Get-Process','Test-Path','robocopy.exe','Out-Null','Remove-Item',
  'Move-Item','Start-Process','Set-Content')
$commands = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true)
foreach ($command in $commands) {
  $name = $command.GetCommandName()
  if (-not $name -or $name -notin $allowed) { throw ('Unapproved helper command: ' + $name) }
}
foreach ($name in @('Get-CimInstance','Get-Process','Stop-Process','Start-Process','Start-Sleep','robocopy.exe')) {
  if ((Get-Command $name).CommandType -ne 'Function') { throw ('Process mock is missing: ' + $name) }
}
@{ major = $PSVersionTable.PSVersion.Major; minor = $PSVersionTable.PSVersion.Minor } |
  ConvertTo-Json -Compress | Microsoft.PowerShell.Management\Set-Content -LiteralPath (Join-Path $PurgeFixtureRoot 'runtime.json') -Encoding UTF8
$global:LASTEXITCODE = 0
& $HelperPath -WaitPid 1040000000 -AsarPath $TargetAsar -ExePath $PurgeFixtureExe
exit $LASTEXITCODE
`;

test("actual ASAR PowerShell helper safely handles success and failures in disposable fixtures", {
  skip: process.platform !== "win32" ? "requires Windows PowerShell 5.1" : false,
}, async (t) => {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, "dsh-purge-ps-swap-"));
  const rootReal = fs.realpathSync(root);
  const ps = path.join(process.env.SystemRoot || process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const helper = productionHelper();
  const sentinel = "unrelated file must remain unchanged\n";
  const outside = path.join(root, "outside-install.asar");
  fs.writeFileSync(outside, sentinel);
  const scenarios = ["success", "move-failure", "move-noop", "invalid-path", "relative-path", "launch-failure"];
  try {
    for (const mode of scenarios) {
      await t.test(mode, () => {
        const fixture = path.join(root, mode);
        const install = path.join(fixture, "DeepSeek Harness fixture");
        const resources = path.join(install, "resources");
        const temp = path.join(fixture, "temp");
        fs.mkdirSync(path.join(resources, "app"), { recursive: true });
        fs.mkdirSync(path.join(resources, "app.asar.unpacked"), { recursive: true });
        fs.mkdirSync(temp, { recursive: true });
        const exe = path.join(install, "DeepSeek Harness.exe");
        const asar = path.join(resources, "app.asar");
        fs.writeFileSync(exe, "fixture only; never executable\n");
        fs.writeFileSync(asar, "fixture sealed archive\n");
        const preserved = path.join(resources, "app", "preserved.txt");
        fs.writeFileSync(preserved, sentinel);
        const helperPath = path.join(fixture, "actual-helper.ps1");
        const harnessPath = path.join(fixture, "harness.ps1");
        fs.writeFileSync(helperPath, "\ufeff" + helper, "utf8");
        fs.writeFileSync(harnessPath, "\ufeff" + harness, "utf8");
        const target = mode === "invalid-path" ? outside : mode === "relative-path" ? "resources\\app.asar" : asar;
        const result = spawnSync(ps, [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", harnessPath, "-HelperPath", helperPath, "-FixtureRoot", fixture,
          "-FixtureMode", mode, "-TargetAsar", target, "-FixtureExe", exe,
        ], {
          cwd: fixture, windowsHide: true, encoding: "utf8", timeout: 15000,
          env: { ...process.env, TEMP: temp, TMP: temp, DSH_HOME: path.join(fixture, "isolated-home") },
        });
        assert.ifError(result.error);
        const readText = (filename) => fs.readFileSync(filename, "utf8").replace(/^\ufeff/, "");
        assert.deepEqual(JSON.parse(readText(path.join(fixture, "runtime.json"))), { major: 5, minor: 1 });
        const auditFile = path.join(fixture, "audit.jsonl");
        const audit = fs.existsSync(auditFile) ? readText(auditFile).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
        const log = readText(path.join(temp, "dsh-purge-asar-swap.log"));
        const launches = audit.filter((entry) => entry.op === "Start-Process");
        const moves = audit.filter((entry) => entry.op === "Move-Item");
        assert.equal(fs.readFileSync(outside, "utf8"), sentinel);
        assert.equal(fs.readFileSync(preserved, "utf8"), sentinel);
        assert.equal(fs.readFileSync(exe, "utf8"), "fixture only; never executable\n");
        assert.equal(result.status, mode === "success" ? 0 : 1, result.stderr || result.stdout || log);
        if (mode === "invalid-path" || mode === "relative-path") {
          assert.deepEqual(audit, [], "invalid paths must stop before any process operation");
          assert.match(log, /invalid paths:/);
          assert.equal(fs.existsSync(asar + ".bak"), false);
          assert.equal(fs.readFileSync(asar, "utf8"), "fixture sealed archive\n");
          return;
        }
        assert.ok(audit.some((entry) => entry.op === "robocopy.exe"), "overlay subprocess is safely mocked");
        assert.deepEqual([...new Set(audit.filter((entry) => entry.op === "Stop-Process").map((entry) => entry.detail))].sort(), [1040000001, 1040000002]);
        assert.ok(moves.length > 0);
        for (const move of moves) assert.equal(move.detail.errorAction, "Stop");
        if (mode === "move-failure" || mode === "move-noop") {
          assert.equal(moves.length, 80, "failed moves exhaust the bounded retry loop");
          assert.deepEqual(launches, [], "never relaunch while the archive remains sealed");
          assert.equal(fs.readFileSync(asar, "utf8"), "fixture sealed archive\n");
          assert.equal(fs.existsSync(asar + ".bak"), false);
          assert.equal(fs.existsSync(asar + ".rename-pending"), true);
          assert.match(log, mode === "move-failure" ? /archive move failed: fixture nonterminating move failure/ : /archive move failed: Archive move did not complete/);
          assert.match(log, /archive handoff failed; desktop was not relaunched/);
        } else {
          assert.equal(moves.length, 1);
          assert.equal(fs.existsSync(asar), false);
          assert.equal(fs.readFileSync(asar + ".bak", "utf8"), "fixture sealed archive\n");
          assert.equal(launches.length, 1);
          assert.equal(launches[0].detail.errorAction, "Stop");
          assert.match(log, /archive moved to backup/);
          if (mode === "launch-failure") {
            assert.match(log, /desktop launch failed: fixture launch rejected/);
            assert.doesNotMatch(log, /desktop launch requested/);
          } else assert.match(log, /desktop launch requested/);
        }
      });
    }
  } finally {
    // Delete only this exact mkdtemp directory after checking its resolved parent.
    assert.equal(fs.realpathSync(root), rootReal);
    assert.equal(path.dirname(rootReal), tempParent);
    assert.ok(path.basename(rootReal).startsWith("dsh-purge-ps-swap-"));
    fs.rmSync(rootReal, { recursive: true, force: true });
  }
});
