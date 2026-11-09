import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicCopyFile, atomicCopyFileSync, atomicWriteFile, atomicWriteSync, shimBackupPath, clearDesktopLocateCache } from '../lib/core.js';
import { repairOfficialCliAfterUnpack, isSealedRuntimeDir } from '../lib/desktop.js';
import { hostFs } from '../lib/extract-asar.js';

const STOCK = '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\nexit /b %errorlevel%\r\n';

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'dsh-cli-backup-'));
  const home = path.join(root, 'home');
  const install = path.join(root, 'DeepSeek Harness');
  const resources = path.join(install, 'resources');
  const bin = path.join(resources, 'runtime', 'cli', 'bin');
  const exe = path.join(install, 'DeepSeek Harness.exe');
  const shim = path.join(bin, 'dsh.cmd');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(resources, 'app'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'fixture archive marker; never opened as an archive');
  fs.mkdirSync(home);
  fs.writeFileSync(exe, 'fixture; never executed');
  fs.writeFileSync(shim, STOCK);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  clearDesktopLocateCache();
  t.after(() => {
    t.mock.restoreAll();
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    clearDesktopLocateCache();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, home, resources, bin, exe, shim };
}

test('same-millisecond concurrent copies use independent temporary files', async t => {
  const { root, shim } = fixture(t);
  const dest = path.join(root, 'launcher.bak');
  t.mock.method(Date, 'now', () => 1794192165275);
  await Promise.all(Array.from({ length: 16 }, () => atomicCopyFile(shim, dest)));
  assert.equal(fs.readFileSync(dest, 'utf8'), STOCK);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.copytmp')), false);
});

test('same-millisecond concurrent writes publish one complete value without temp collisions', async t => {
  const { root } = fixture(t);
  const dest = path.join(root, 'state.json');
  const values = Array.from({ length: 16 }, (_, i) => JSON.stringify({ id: i, body: String(i).repeat(4096) }));
  t.mock.method(Date, 'now', () => 1794192165275);
  await Promise.all(values.map(value => atomicWriteFile(dest, value)));
  assert.ok(values.includes(fs.readFileSync(dest, 'utf8')));
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
});

test('official CLI directories use external backup paths while ordinary bin directories do not', t => {
  const { bin, shim, home, root } = fixture(t);
  assert.equal(isSealedRuntimeDir(bin), true);
  const backup = shimBackupPath(shim);
  assert.ok(backup.startsWith(home + path.sep));
  assert.notEqual(path.dirname(backup), bin);
  const ordinary = path.join(root, 'ordinary', 'bin');
  assert.equal(isSealedRuntimeDir(ordinary), false);
  assert.equal(shimBackupPath(path.join(ordinary, 'dsh.cmd')), path.join(ordinary, 'dsh.cmd.dshpurge.bak'));
});

test('CLI repair synchronously preserves original bytes before changing its launcher', t => {
  const { exe, shim, bin } = fixture(t);
  t.mock.method(hostFs.promises, 'copyFile', () => { throw new Error('synchronous repair must never start an async backup'); });
  const result = repairOfficialCliAfterUnpack(exe);
  assert.equal(result.ok, true);
  const row = result.shims.find(row => row.path === shim);
  assert.equal(row.status, 'patched');
  assert.equal(fs.readFileSync(row.backup, 'utf8'), STOCK);
  assert.notEqual(path.dirname(row.backup), bin);
  assert.match(fs.readFileSync(shim, 'utf8'), /app\\dsh\\node_modules/);
  assert.deepEqual(fs.readdirSync(bin), ['dsh.cmd']);
  const repeated = repairOfficialCliAfterUnpack(exe);
  assert.equal(repeated.shims.find(row => row.path === shim).status, 'already');
  assert.equal(fs.readFileSync(row.backup, 'utf8'), STOCK);
});

test('CLI repair preserves an existing legacy original and does not overwrite its external backup', t => {
  const { exe, shim } = fixture(t);
  const legacy = shim + '.dsh-purge.bak';
  const historical = STOCK + 'REM preserved historical original\r\n';
  fs.writeFileSync(legacy, historical);
  const first = repairOfficialCliAfterUnpack(exe);
  const backup = first.shims.find(row => row.path === shim).backup;
  assert.equal(fs.readFileSync(backup, 'utf8'), historical);
  assert.equal(fs.readFileSync(legacy, 'utf8'), historical);
  fs.writeFileSync(shim, STOCK + 'REM newer launcher\r\n');
  assert.equal(repairOfficialCliAfterUnpack(exe).ok, true);
  assert.equal(fs.readFileSync(backup, 'utf8'), historical);
});

test('backup failure returns a synchronous error report and leaves the launcher intact', t => {
  const { exe, shim, bin } = fixture(t);
  t.mock.method(hostFs, 'copyFileSync', () => { throw Object.assign(new Error('fixture denied backup'), { code: 'EACCES' }); });
  const result = repairOfficialCliAfterUnpack(exe);
  assert.equal(result.ok, false);
  assert.match(result.error, /backup failed/);
  assert.equal(result.shims.find(row => row.path === shim).status, 'backup_error');
  assert.equal(fs.readFileSync(shim, 'utf8'), STOCK);
  assert.deepEqual(fs.readdirSync(bin), ['dsh.cmd']);
});

for (const mode of ['sync', 'async']) {
  test(`${mode} copy rename failure preserves an existing destination and removes temporary files`, async t => {
    const { root, shim } = fixture(t);
    const dest = path.join(root, 'backup');
    fs.writeFileSync(dest, 'keep existing backup');
    const failure = Object.assign(new Error('fixture rename denied'), { code: 'EACCES' });
    if (mode === 'sync') {
      t.mock.method(hostFs, 'renameSync', () => { throw failure; });
      assert.throws(() => atomicCopyFileSync(shim, dest), error => error === failure);
    } else {
      t.mock.method(hostFs.promises, 'rename', async () => { throw failure; });
      await assert.rejects(atomicCopyFile(shim, dest), error => error === failure);
    }
    assert.equal(fs.readFileSync(dest, 'utf8'), 'keep existing backup');
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.copytmp')), false);
  });

  test(`${mode} partial write failure preserves existing content and removes its temporary file`, async t => {
    const { root } = fixture(t);
    const dest = path.join(root, 'content');
    fs.writeFileSync(dest, 'keep existing content');
    const failure = Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    const failAfterPartialWrite = filename => { fs.writeFileSync(filename, 'partial'); throw failure; };
    if (mode === 'sync') {
      t.mock.method(hostFs, 'writeFileSync', failAfterPartialWrite);
      assert.throws(() => atomicWriteSync(dest, 'replacement'), error => error === failure);
    } else {
      t.mock.method(hostFs.promises, 'writeFile', async filename => failAfterPartialWrite(filename));
      await assert.rejects(atomicWriteFile(dest, 'replacement'), error => error === failure);
    }
    assert.equal(fs.readFileSync(dest, 'utf8'), 'keep existing content');
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
  });
}
