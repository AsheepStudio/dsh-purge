import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("compatibility updater guards the real public APIs before host discovery or side effects", async (t) => {
  const tempRoot = path.resolve(os.tmpdir());
  const sandbox = fs.mkdtempSync(path.join(tempRoot, "dsh-purge-updater-guard-"));
  const previousHome = process.env.DSH_HOME;
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageJson = fs.readFileSync(packagePath, "utf8");
  const packageData = JSON.parse(packageJson);
  assert.match(packageData.version, /-compat\./, "this suite belongs to the dedicated compatibility build");
  const channelPath = path.join(sandbox, "dsh-purge", "channel.json");
  const files = {
    "dsh-purge/channel.json": '{"channel":"beta","pin":"1.1.11-beta.1"}\n',
    "dsh-purge/version-history.json": '[{"version":"sentinel-history"}]\n',
    "dsh-purge/installed-rev": "sentinel-revision\n",
    "dsh-purge/custom-prompt.md": "sentinel personal prompt\n",
    "profiles/desktop/package.json": '{"dependencies":{"dsh-purge":"sentinel-original-spec"}}\n',
    "profiles/desktop/pnpm-lock.yaml": "sentinel lockfile\n",
    "host/resources/app.asar": "sentinel sealed desktop archive\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(sandbox, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  }
  process.env.DSH_HOME = sandbox;
  const undo = [];
  const calls = [];
  let version = packageData.version;
  let legacyChannelRead = false;
  const replace = (object, key, replacement) => {
    const original = object[key];
    object[key] = replacement;
    undo.push(() => { object[key] = original; });
  };
  const trap = (label) => () => {
    calls.push(label);
    throw new Error(`unexpected updater side effect: ${label}`);
  };
  let updater;
  try {
    // Import the real API under an isolated DSH_HOME. Module initialization is
    // declarative; all API calls below run behind filesystem/process/network traps.
    updater = await import("../lib/update.js");
    replace(fs, "readFileSync", (filename) => {
      if (path.resolve(String(filename)) === packagePath) {
        return JSON.stringify({ ...packageData, version });
      }
      if (legacyChannelRead && path.resolve(String(filename)) === channelPath) {
        return '{"channel":"beta","pin":"1.1.70"}';
      }
      return trap("fs.readFileSync")();
    });
    for (const name of [
      "access", "accessSync", "appendFile", "appendFileSync", "chmod", "chmodSync",
      "chown", "chownSync", "copyFile", "copyFileSync", "cp", "cpSync",
      "createReadStream", "createWriteStream", "existsSync", "link", "linkSync",
      "lstat", "lstatSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync",
      "open", "openSync", "opendir", "opendirSync", "readFile", "readdir", "readdirSync",
      "readlink", "readlinkSync", "realpath", "realpathSync", "rename", "renameSync",
      "rm", "rmSync", "rmdir", "rmdirSync", "stat", "statSync", "symlink", "symlinkSync",
      "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync",
      "write", "writeSync", "writeFile", "writeFileSync", "writev", "writevSync",
    ]) {
      if (typeof fs[name] === "function") replace(fs, name, trap(`fs.${name}`));
    }
    for (const [name, value] of Object.entries(fs.promises)) {
      if (typeof value === "function") replace(fs.promises, name, trap(`fs.promises.${name}`));
    }
    for (const name of ["exec", "execSync", "execFile", "execFileSync", "fork", "spawn", "spawnSync"]) {
      replace(childProcess, name, trap(`child_process.${name}`));
    }
    for (const [protocol, client] of [["http", http], ["https", https]]) {
      replace(client, "get", trap(`${protocol}.get`));
      replace(client, "request", trap(`${protocol}.request`));
    }
    if (typeof globalThis.fetch === "function") replace(globalThis, "fetch", trap("fetch"));
    replace(os, "homedir", trap("os.homedir"));
    replace(os, "tmpdir", trap("os.tmpdir"));
    replace(process, "kill", trap("process.kill"));
    // Named imports in core.js/update.js must observe the same process traps.
    syncBuiltinESMExports();

    const message = /兼容版.*内置更新.*通道切换.*回退.*兼容安装包/;
    await t.test("check/status/version-list return an explicit no-update result without reading channel state", async () => {
      for (const invoke of [
        () => updater.checkUpdate(),
        ...["check", "status", "versions"].map((op) => () => updater.handleUpdateOp({ op })),
      ]) {
        const result = await invoke();
        assert.equal(result.ok, true);
        assert.equal(result.hasUpdate, false);
        assert.equal(result.skipped, "compatibility-build");
        assert.equal(result.localVersion, packageData.version);
        assert.match(result.error, message, "the existing UI displays the explanatory error field");
        assert.deepEqual(result.versions, []);
        assert.equal(updater.lastUpdateResult(), result);
      }
      assert.deepEqual(calls, []);
    });

    const operations = [
      ["applyUpdate() default job discovery", () => updater.applyUpdate()],
      ["applyUpdate(undefined, options)", () => updater.applyUpdate(undefined, { ref: "master" })],
      ["applyUpdate(options) overload", () => updater.applyUpdate({ ref: "master" })],
      ["applyUpdate(explicit jobs)", () => updater.applyUpdate([{ kind: "zip", dir: sandbox }])],
      ["switchChannel(stable)", () => updater.switchChannel("stable")],
      ["switchChannel(beta)", () => updater.switchChannel("beta")],
      ["switchChannel(apply:false) state-only mutation", () => updater.switchChannel("beta", { apply: false })],
      ["switchVersion(master)", () => updater.switchVersion("master")],
      ["switchVersion(empty) guard before version lookup", () => updater.switchVersion("")],
      ["handleUpdateOp() default", () => updater.handleUpdateOp()],
      ["handleUpdateOp(apply)", () => updater.handleUpdateOp({ op: "apply", ref: "master" })],
      ["handleUpdateOp(channel)", () => updater.handleUpdateOp({ op: "channel", channel: "stable" })],
      ["handleUpdateOp(channel, apply:false)", () => updater.handleUpdateOp({ op: "channel", channel: "beta", apply: false })],
      ["handleUpdateOp(switch)", () => updater.handleUpdateOp({ op: "switch", version: "1.1.71" })],
      ["handleUpdateOp(rollback)", () => updater.handleUpdateOp({ op: "rollback", id: "1.1.70" })],
      ["handleUpdateOp(unknown) fallback", () => updater.handleUpdateOp({ op: "unknown" })],
    ];
    for (const [name, invoke] of operations) {
      await t.test(`${name} refuses before discovery, writes, download, or execution`, async () => {
        await assert.rejects(invoke, message);
        assert.deepEqual(calls, [], "even swallowed discovery/IO errors must be detected");
      });
    }

    await t.test("startup auto-update stays manual-only without normalizing channel.json", async () => {
      for (const invoke of [
        () => updater.autoUpdateIfNeeded(),
        () => updater.handleUpdateOp({ op: "auto" }),
        () => updater.handleUpdateOp({ auto: true }),
      ]) {
        const result = await invoke();
        assert.equal(result.auto, true);
        assert.equal(result.skipped, "manual-only");
        assert.equal(result.hasUpdate, false);
        assert.equal(result.error, "");
      }
      assert.deepEqual(calls, []);
    });

    await t.test("non-compat versions retain validation, manual-only startup, and version comparison", async () => {
      version = "1.1.71";
      await assert.rejects(() => updater.switchVersion(""), /请选择要回退的版本/);
      await assert.rejects(() => updater.switchVersion("1.1.11-beta.1"), /该版本已下线/);
      legacyChannelRead = true;
      const result = await updater.autoUpdateIfNeeded();
      assert.equal(result.skipped, "manual-only");
      assert.equal(result.channel, "beta");
      assert.equal(result.pin, "1.1.70");
      assert.equal(updater.versionIsNewer("1.1.71", packageData.version), true);
      assert.equal(updater.versionIsNewer("1.1.72", "1.1.71"), true);
      assert.equal(updater.versionIsNewer("1.1.70", "1.1.71"), false);
      assert.deepEqual(calls, []);
    });
  } finally {
    for (const restore of undo.reverse()) restore();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    try {
      // The invalid beta pin would be rewritten if readChannelState ran. Compare
      // every sentinel, including private prompts/profile specs/the sealed ASAR.
      for (const [relative, content] of Object.entries(files)) {
        assert.equal(fs.readFileSync(path.join(sandbox, relative), "utf8"), content, relative);
      }
      assert.equal(fs.readFileSync(packagePath, "utf8"), packageJson);
    } finally {
      assert.equal(path.dirname(path.resolve(sandbox)), tempRoot);
      assert.ok(path.basename(sandbox).startsWith("dsh-purge-updater-guard-"));
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }
});
