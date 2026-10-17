import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import nodeFs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as desktop from "../lib/desktop.js";
import { hostFs } from "../lib/extract-asar.js";

// The production WSH script currently contains non-ASCII comments, so ordinary
// calls select PowerShell. Inject only this capability predicate to exercise the
// dormant WSH launch error handler through the real public restart API.
const wshModuleUrl = new URL("../lib/desktop.js?restart-test-wsh", import.meta.url).href;
const officialUpdateUrl = new URL("../lib/official-update.js", import.meta.url).href;
const wshCapabilitySource = `export { wshLiteral } from ${JSON.stringify(officialUpdateUrl)}; export const isWshAscii = () => true;`;
const wshHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === wshModuleUrl && specifier === "./official-update.js") {
      return { url: `data:text/javascript,${encodeURIComponent(wshCapabilitySource)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
let wshDesktop;
try {
  wshDesktop = await import(wshModuleUrl);
} finally {
  wshHook.deregister();
}

function missing(file) {
  return Object.assign(new Error(`ENOENT: fixture has no ${String(file)}`), { code: "ENOENT" });
}

// Every disk/process operation used by these APIs is intercepted. No fixtures
// are created on disk, installed apps are never searched, and no helper runs.
function isolatedRestart(t, { sealed = true, clean = true, platform = "win32", synchronousSpawnError = false } = {}) {
  const root = fileURLToPath(new URL("./fixtures/virtual-desktop-install", import.meta.url));
  const exe = path.join(root, "DeepSeek Harness.exe");
  const resources = path.join(root, "resources");
  const asar = path.join(resources, "app.asar");
  const prompt = path.join(resources, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js");
  const home = path.join(root, ".dsh");
  const temp = path.join(root, "temp");
  const key = (file) => path.normalize(file instanceof URL ? fileURLToPath(file) : String(file));
  const files = new Map([
    [key(exe), "fixture executable; never executed"],
    [key(prompt), clean
      ? "system-prompt/assemble\n[dsh-purge] identity stripped\n[dsh-purge] complete prompt keeps inject"
      : "system-prompt/assemble\nsections: completeSection === void 0 ? transformed.sections : [completeSection]"],
  ]);
  if (sealed) files.set(key(asar), "fixture archive; never executed or extracted");
  const directories = new Set([root, resources, temp, home].map(key));
  const spawned = [];
  const timers = [];
  const exits = [];
  const oldExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
  const oldPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const oldResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  const oldHome = process.env.DSH_HOME;
  const oldNoDeprecation = process.noDeprecation;

  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "execPath", oldExecPath);
    Object.defineProperty(process, "platform", oldPlatform);
    if (oldResources) Object.defineProperty(process, "resourcesPath", oldResources);
    else delete process.resourcesPath;
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    process.noDeprecation = oldNoDeprecation;
  });

  const fsMethods = {
    existsSync(file) { return files.has(key(file)) || directories.has(key(file)); },
    statSync(file) {
      const fileKey = key(file);
      if (!files.has(fileKey) && !directories.has(fileKey)) throw missing(file);
      return { mtimeMs: Date.now(), size: files.get(fileKey)?.length ?? 0,
        isFile: () => files.has(fileKey), isDirectory: () => directories.has(fileKey) };
    },
    readFileSync(file, encoding) {
      if (!files.has(key(file))) throw missing(file);
      const body = files.get(key(file));
      return encoding ? body : Buffer.from(body);
    },
    writeFileSync(file, body) { files.set(key(file), String(body)); },
    appendFileSync(file, body) { files.set(key(file), (files.get(key(file)) ?? "") + String(body)); },
    unlinkSync(file) { if (!files.delete(key(file))) throw missing(file); },
    rmSync(file) { files.delete(key(file)); directories.delete(key(file)); },
    mkdirSync(file) { directories.add(key(file)); },
    readdirSync() { return []; },
    realpathSync(file) { return key(file); },
    copyFileSync(from, to) {
      if (!files.has(key(from))) throw missing(from);
      files.set(key(to), files.get(key(from)));
    },
  };
  for (const [name, implementation] of Object.entries(fsMethods)) {
    t.mock.method(nodeFs, name, implementation);
    if (typeof hostFs[name] === "function") t.mock.method(hostFs, name, implementation);
  }
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (synchronousSpawnError) throw new Error("fixture spawn blocked");
    const child = new EventEmitter();
    child.unrefs = 0;
    child.unref = () => { child.unrefs += 1; };
    child.kill = () => { throw new Error("the caller must not kill real or fixture processes"); };
    spawned.push({ command, args, options, child });
    return child;
  });
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    assert.equal(command, "cscript.exe", "never run registry, process, shell, or discovery commands");
    const probe = args[1];
    assert.match(probe, /dsh-purge-wsh-probe-/);
    files.set(key(probe.replace(/\.js$/, ".txt")), "ok");
    return Buffer.alloc(0);
  });
  syncBuiltinESMExports();
  t.mock.method(os, "tmpdir", () => temp);
  t.mock.method(process, "exit", (code) => { exits.push(code); });
  t.mock.method(process, "kill", () => { throw new Error("real process killing is forbidden in this test"); });
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = { callback, delay, args, unref() { return this; } };
    timers.push(timer);
    return timer;
  });
  Object.defineProperty(process, "execPath", { ...oldExecPath, value: exe });
  Object.defineProperty(process, "platform", { ...oldPlatform, value: platform });
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: resources });
  process.env.DSH_HOME = home;

  return {
    exe, asar, prompt, files, spawned, timers, exits,
    runAllTimers() {
      // Exercise the old 250/1500/2000 ms failure windows without wall-clock waits.
      for (const timer of timers.splice(0)) timer.callback(...timer.args);
    },
    logs() { return [...files.entries()].filter(([file]) => /\.log$/.test(file)).map(([, body]) => body).join("\n"); },
  };
}

function assertDetachedLaunch(launch) {
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.stdio, "ignore");
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.child.unrefs, 1);
}

for (const runtimeKind of ["absent", "resolves", "throws", "rejects"]) {
  test(`sealed PowerShell restart leaves host alive and never invokes ${runtimeKind} runtime`, async (t) => {
    const fixture = isolatedRestart(t);
    let calls = 0;
    const runtime = runtimeKind === "absent" ? null : { requestRestart() {
      calls += 1;
      if (runtimeKind === "throws") throw new Error("fixture runtime throws");
      if (runtimeKind === "rejects") return Promise.reject(new Error("fixture runtime rejects"));
      return Promise.resolve();
    } };
    assert.deepEqual(desktop.scheduleAsarSwapRestart({ exe: fixture.exe, asar: fixture.asar, exit: true, runtime }), { scheduled: true });
    assert.equal(fixture.spawned.length, 1);
    assert.equal(fixture.spawned[0].command, "powershell.exe");
    assertDetachedLaunch(fixture.spawned[0]);
    fixture.runAllTimers();
    await Promise.resolve();
    assert.equal(calls, 0, "the helper owns shutdown; runtime acknowledgement is not a supported assumption");
    assert.deepEqual(fixture.exits, [], "a slow or blocked helper must not cause independent host exit");
  });
}

test("sealed PowerShell exit:false stays alive when helper startup emits an asynchronous error", (t) => {
  const fixture = isolatedRestart(t);
  desktop.scheduleAsarSwapRestart({ exe: fixture.exe, asar: fixture.asar, exit: false });
  assert.doesNotThrow(() => fixture.spawned[0].child.emit("error", new Error("fixture ENOENT")));
  fixture.runAllTimers();
  assert.deepEqual(fixture.exits, []);
  assert.match(fixture.logs(), /spawn failed: fixture ENOENT/);
});

test("sealed restart does not consult a context's runtime service", (t) => {
  const fixture = isolatedRestart(t);
  let lookups = 0;
  desktop.scheduleAsarSwapRestart({ exe: fixture.exe, asar: fixture.asar, exit: true,
    ctx: { get() { lookups += 1; throw new Error("fixture runtime lookup must not occur"); } } });
  fixture.runAllTimers();
  assert.equal(lookups, 0);
  assert.deepEqual(fixture.exits, []);
});

test("non-Windows sealed helper keeps host alive across delayed startup and asynchronous spawn failure", (t) => {
  const fixture = isolatedRestart(t, { platform: "linux" });
  desktop.scheduleAsarSwapRestart({ exe: fixture.exe, asar: fixture.asar, exit: true });
  assert.equal(fixture.spawned.length, 1);
  const launch = fixture.spawned[0];
  assertDetachedLaunch(launch);
  const payload = JSON.parse(launch.options.env.DSH_PURGE_RESTART);
  assert.equal(payload.killApp, true);
  assert.equal(payload.asar, fixture.asar);
  assert.equal(payload.execPath, fixture.exe);
  fixture.runAllTimers();
  assert.deepEqual(fixture.exits, []);
  assert.doesNotThrow(() => launch.child.emit("error", new Error("fixture helper blocked")));
  assert.match(fixture.logs(), /spawn failed: fixture helper blocked/);
});

test("official unpacked helper owns shutdown without the former 250 ms host exit", (t) => {
  const fixture = isolatedRestart(t, { sealed: false });
  const result = desktop.restartOfficialHarness({ exe: fixture.exe, asar: fixture.asar, exit: true });
  assert.deepEqual(result, { restarting: true, mode: "unpacked-helper", engine: "helper" });
  assert.equal(fixture.spawned.length, 1);
  const launch = fixture.spawned[0];
  assertDetachedLaunch(launch);
  const payload = JSON.parse(launch.options.env.DSH_PURGE_RESTART);
  assert.equal(payload.killApp, true);
  assert.equal(payload.asar, null);
  fixture.runAllTimers();
  assert.deepEqual(fixture.exits, []);
  assert.doesNotThrow(() => launch.child.emit("error", new Error("fixture unpacked helper blocked")));
  assert.match(fixture.logs(), /spawn failed: fixture unpacked helper blocked/);
});

test("official sealed restart retains normal host-content checks before helper launch", (t) => {
  const fixture = isolatedRestart(t, { clean: false });
  const result = desktop.restartOfficialHarness({ exe: fixture.exe, asar: fixture.asar, exit: true });
  assert.deepEqual(result, { restarting: false, clean: false });
  assert.equal(fixture.spawned.length, 0);
  fixture.runAllTimers();
  assert.deepEqual(fixture.exits, []);
});

test("official restart refuses a missing system-prompt file", (t) => {
  const fixture = isolatedRestart(t);
  fixture.files.delete(fixture.prompt);
  assert.deepEqual(desktop.restartOfficialHarness({ exe: fixture.exe, asar: fixture.asar }), { restarting: false, clean: false });
  assert.equal(fixture.spawned.length, 0);
});

test("official sealed restart reports synchronous helper launch failure without exiting host", (t) => {
  const fixture = isolatedRestart(t, { synchronousSpawnError: true });
  const result = desktop.restartOfficialHarness({ exe: fixture.exe, asar: fixture.asar, exit: true });
  assert.equal(result.restarting, false);
  assert.match(result.error, /fixture spawn blocked/);
  fixture.runAllTimers();
  assert.deepEqual(fixture.exits, []);
});

test("WSH launcher handles asynchronous errors without an uncaught child error or host exit", (t) => {
  const fixture = isolatedRestart(t);
  const result = wshDesktop.restartOfficialHarness({ exe: fixture.exe, asar: fixture.asar, exit: true });
  assert.deepEqual(result, { restarting: true, engine: "wscript" });
  assert.equal(fixture.spawned.length, 1);
  const launch = fixture.spawned[0];
  assert.equal(launch.command, "wscript.exe");
  assertDetachedLaunch(launch);
  assert.doesNotThrow(() => launch.child.emit("error", new Error("fixture WSH blocked")));
  fixture.runAllTimers();
  assert.deepEqual(fixture.exits, []);
  assert.match(fixture.logs(), /spawn failed: fixture WSH blocked/);
});
