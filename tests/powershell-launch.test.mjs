import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the public launch API with native Windows PowerShell while replacing
// its entire script body before it is written. The real swap/process-stop code
// is never run. Every artifact lives in one disposable test directory.
const runner = String.raw`
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [fixtureRoot, desktopUrl, extractUrl, mode] = process.argv.slice(2);
os.tmpdir = () => fixtureRoot;
process.env.TEMP = fixtureRoot;
process.env.TMP = fixtureRoot;
const { hostFs } = await import(extractUrl);
const write = fs.writeFileSync.bind(fs);
const benign = '\ufeffparam([int]$WaitPid, [string]$AsarPath, [string]$ExePath)\r\n' +
  'Start-Sleep -Milliseconds 800\r\n' +
  '[Console]::Out.WriteLine("native probe stdout")\r\n' +
  '[Console]::Error.WriteLine("native probe stderr")\r\n' +
  '[IO.File]::WriteAllText($AsarPath, "benign probe completed")\r\n' +
  'exit 17\r\n';
let scriptPath;
hostFs.writeFileSync = (file, body, ...args) => {
  assert.equal(path.dirname(file), fixtureRoot);
  assert.match(path.basename(file), /^dsh-purge-asar-swap-[\da-f-]+\.ps1$/);
  assert.match(String(body), /param\(/);
  assert.equal(scriptPath, undefined, 'only one production script is allowed');
  scriptPath = file;
  return write(file, benign, ...args);
};
const nativeSpawn = childProcess.spawn.bind(childProcess);
let launched;
childProcess.spawn = (command, args, options) => {
  assert.ok(!launched, 'only the selected restart launcher may be started');
  assert.match(path.basename(command), /^(?:powershell|conhost)\.exe$/i);
  const fileIndex = args.indexOf('-File');
  assert.notEqual(fileIndex, -1);
  assert.equal(args[fileIndex + 1], scriptPath);
  assert.equal(fs.readFileSync(scriptPath, 'utf8'), benign, 'never execute the production swap body');
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.ok(Array.isArray(options.stdio));
  const child = nativeSpawn(command, args, options);
  launched = child;
  return child;
};
syncBuiltinESMExports();
const { scheduleAsarSwapRestart } = await import(desktopUrl);
const marker = path.join(fixtureRoot, 'benign-completed.txt');
const result = scheduleAsarSwapRestart({
  exe: path.join(fixtureRoot, 'unused.exe'), asar: marker, waitPid: 0, exit: true,
});
assert.deepEqual(result, { scheduled: true }, 'dispatch acknowledgement must not claim execution success');
assert.ok(launched);
const timer = setTimeout(() => { throw new Error('native launcher timed out'); }, 12000);
launched.once('error', (error) => { throw error; });
if (mode === 'parent-exits') {
  launched.once('spawn', () => {
    write(path.join(fixtureRoot, 'parent-exited.txt'), 'before helper marker');
    assert.equal(fs.existsSync(marker), false, 'probe must still be waiting when parent exits');
    process.exit(0);
  });
} else {
  // Console-host lifetime/exit status is not proof of PowerShell completion.
  // Observe the benign script's own marker while the parent remains alive.
  const watcher = setInterval(() => {
    if (!fs.existsSync(marker)) return;
    clearInterval(watcher);
    clearTimeout(timer);
  }, 25);
}
`;

async function waitFor(file, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    await delay(50);
  }
  return null;
}

for (const mode of ["parent-waits", "parent-exits"]) {
  test(`native PowerShell launch captures output and runs when ${mode}`, { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-launch-fixture-"));
    const expectedParent = path.resolve(os.tmpdir());
    t.after(() => {
      assert.equal(path.dirname(path.resolve(root)), expectedParent);
      assert.match(path.basename(root), /^dsh-purge-launch-fixture-/);
      fs.rmSync(root, { recursive: true, force: true });
    });
    const runnerPath = path.join(root, "native-launch-runner.mjs");
    fs.writeFileSync(runnerPath, runner);
    const result = spawnSync(process.execPath, [
      runnerPath, root,
      new URL("../lib/desktop.js", import.meta.url).href,
      new URL("../lib/extract-asar.js", import.meta.url).href,
      mode,
    ], { encoding: "utf8", timeout: 18000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    if (mode === "parent-exits") assert.ok(fs.existsSync(path.join(root, "parent-exited.txt")));
    assert.equal(await waitFor(path.join(root, "benign-completed.txt")), "benign probe completed",
      "helper must run its script and survive the launching Host exiting");
    const output = fs.readdirSync(root).filter((name) => name.endsWith(".log"))
      .map((name) => fs.readFileSync(path.join(root, name), "utf8")).join("\n");
    assert.match(output, /native probe stdout/);
    assert.match(output, /native probe stderr/);
  });
}
