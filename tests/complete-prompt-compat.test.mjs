import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ALL_PATCHES, applyReplacementsToText } from "../lib/core.js";
import { hostPromptKeepsInject } from "../lib/host-clean.js";

// These tests call only the text patcher and the text guard. They never discover
// installed hosts, apply disk patches, rename app.asar, or request a restart.
const patch = ALL_PATCHES.find((entry) => entry.id === 40);
assert.ok(patch, "the real patch #40 must be exported");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const official = new Map(["0.2.0-rc.2", "0.2.1-rc.2"].map((version) => [
  version,
  fixture(`system-prompt-${version}.fragment.txt`),
]));
const legacy = JSON.parse(fixture("system-prompt-legacy.json"));

function compile(source) {
  return new AsyncFunction(
    "scopeTarget", "scope", "assembly", "context", "completeSection",
    "runtimeContextSuppressed", "contextByName", source,
  );
}

function freezeEntries(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

async function exercise(source, { complete, suppressed }) {
  const completeSection = complete ? Object.freeze({ name: "preset", text: "complete preset", interpolate: false }) : undefined;
  const sections = freezeEntries([
    { name: "preset", text: "waterfall duplicate one" },
    { name: "agent-instructions", text: "workspace instructions" },
    { name: "dsh-purge-inject", text: "new waterfall injection" },
    { name: "other-plugin", text: "keep other plugin content" },
    { name: "preset", text: "waterfall duplicate two" },
    { name: "dsh-purge-extra", text: "additional waterfall injection" },
  ]);
  const contexts = freezeEntries([
    { name: "required", text: "required content transformed by waterfall", metadata: "preserve me" },
    { name: "optional", text: "optional content transformed by waterfall" },
    { name: "injected-only", text: "new context absent from registrations", required: true },
    { name: "truthy", text: "truthy is not required === true" },
  ]);
  const definitions = freezeEntries([
    { name: "required", required: true, text: "original required content" },
    { name: "optional", required: false, text: "original optional content" },
    { name: "truthy", required: 1, text: "original truthy content" },
  ]);
  const contextByName = new Map(definitions.map((entry) => [entry.name, entry]));
  const assembly = Object.freeze({
    sections: freezeEntries([{ name: "dsh-purge-stale", text: "pre-waterfall injection must not return" }]),
    contexts: definitions,
  });
  const tools = Object.freeze([{ name: "fixture-tool" }]);
  const variables = Object.freeze({ fixture: "value" });
  const transformed = Object.freeze({ sections, contexts, tools, variables, extension: "kept" });
  const scope = Object.freeze({ id: "fixture-scope" });
  const context = Object.freeze({ scope });
  const target = Object.freeze({ id: "fixture-target" });
  let calls = 0;
  const host = {
    ctx: {
      async waterfall(actualTarget, event, actualAssembly, actualContext, fallback) {
        calls += 1;
        assert.equal(actualTarget, target);
        assert.equal(event, "system-prompt/assemble");
        assert.equal(actualAssembly, assembly);
        assert.equal(actualContext, context);
        assert.equal(await fallback(), assembly);
        return transformed;
      },
    },
  };
  const scopeTarget = (actualHost, actualScope) => {
    assert.equal(actualHost, host);
    assert.equal(actualScope, scope);
    return target;
  };
  const result = await compile(source).call(host, scopeTarget, scope, assembly, context, completeSection, suppressed, contextByName);
  assert.equal(calls, 1, "the actual waterfall must run exactly once");
  assert.equal(result.tools, tools);
  assert.equal(result.variables, variables);
  assert.equal(result.extension, "kept");
  return { result, completeSection, sections, contexts, definitions, transformed };
}

function checkSections({ result, completeSection, sections }, complete) {
  const injected = [sections[2], sections[5]];
  const rest = complete ? [sections[1], sections[3]] : [sections[0], sections[1], sections[3], sections[4]];
  const expected = complete ? [...injected, ...rest, completeSection] : [...injected, ...rest];
  assert.deepEqual(result.sections, expected);
  for (const entry of [...injected, ...rest]) assert.ok(result.sections.includes(entry), "keep waterfall section objects");
  assert.ok(!result.sections.some((entry) => entry.name === "dsh-purge-stale"));
  if (complete) {
    assert.equal(result.sections.filter((entry) => entry.name === completeSection.name).length, 1);
    assert.notEqual(result.sections.at(-1), completeSection, "copy the complete section rather than mutate it");
  }
}

for (const [version, source] of official) {
  for (const indentation of ["tabs", "spaces"]) {
    for (const newline of ["LF", "CRLF"]) {
      test(`${version}: matches authentic source, valid syntax, idempotent (${indentation}, ${newline})`, () => {
        let input = indentation === "spaces" ? source.replace(/\t/g, "    ") : source;
        if (newline === "CRLF") input = input.replace(/\n/g, "\r\n");
        assert.doesNotThrow(() => compile(input));
        assert.equal(hostPromptKeepsInject(input), false, "unpatched host must fail the guard");
        const output = applyReplacementsToText(input, patch);
        assert.equal(output.changed, true, "must patch the literal npm fixture, not a synthetic pattern");
        assert.doesNotThrow(() => compile(output.text));
        assert.equal(hostPromptKeepsInject(output.text), true);
        assert.deepEqual(applyReplacementsToText(output.text, patch), { text: output.text, changed: false });
        if (newline === "CRLF") assert.ok(!/(?<!\r)\n/.test(output.text), "preserve CRLF throughout");
        else assert.ok(!output.text.includes("\r"), "preserve LF throughout");
      });
    }
  }

  for (const complete of [false, true]) {
    for (const suppressed of [false, true]) {
      test(`${version}: complete=${complete}, runtimeContextSuppressed=${suppressed}`, async () => {
        const output = applyReplacementsToText(source, patch);
        assert.equal(output.changed, true);
        const outcome = await exercise(output.text, { complete, suppressed });
        checkSections(outcome, complete);
        if (!suppressed) {
          assert.equal(outcome.result.contexts, outcome.contexts, "unsuppressed contexts must keep their array identity");
        } else if (version === "0.2.1-rc.2") {
          assert.deepEqual(outcome.result.contexts, [outcome.contexts[0]]);
          assert.equal(outcome.result.contexts[0], outcome.contexts[0], "keep transformed required context objects");
          assert.notEqual(outcome.result.contexts[0], outcome.definitions[0], "do not restore stale pre-waterfall content");
        } else {
          assert.deepEqual(outcome.result.contexts, [], "preserve the 0.2.0 suppression behavior");
        }
      });
    }
  }
}

test("0.2.1 upstream baseline preserves required contexts but drops injected complete-prompt sections", async () => {
  const { result, completeSection, contexts } = await exercise(official.get("0.2.1-rc.2"), { complete: true, suppressed: true });
  assert.deepEqual(result.sections, [completeSection]);
  assert.deepEqual(result.contexts, [contexts[0]]);
  assert.equal(result.contexts[0], contexts[0]);
});

for (const { name, source, expectedChanged } of legacy) {
  for (const newline of ["LF", "CRLF"]) {
    test(`${name}: accepts a previously emitted patch and remains idempotent (${newline})`, async () => {
      const input = newline === "CRLF" ? source.replace(/\n/g, "\r\n") : source;
      const output = applyReplacementsToText(input, patch);
      assert.equal(output.changed, expectedChanged);
      assert.doesNotThrow(() => compile(output.text));
      assert.equal(hostPromptKeepsInject(output.text), true);
      assert.deepEqual(applyReplacementsToText(output.text, patch), { text: output.text, changed: false });
      const outcome = await exercise(output.text, { complete: true, suppressed: true });
      checkSections(outcome, true);
      assert.deepEqual(outcome.result.contexts, []);
    });
  }
}

for (const [name, alter] of [
  ["different required predicate", (source) => source.replace("entry.required === true", "entry.required !== false")],
  ["different registered name", (source) => source.replace(".map((entry) => entry.name)", ".map((entry) => entry.id)")],
  ["different transformed name", (source) => source.replace("requiredContexts.has(entry.name)", "requiredContexts.has(entry.id)")],
  ["unknown collection construction", (source) => source.replace("new Set([...contextByName.values()]", "new Set([...otherContexts.values()]")],
  ["missing required declaration", (source) => source.replace(/^\t\tconst requiredContexts = .*\n/m, "")],
]) {
  test(`0.2.1 unknown source fails closed: ${name}`, () => {
    const source = alter(official.get("0.2.1-rc.2"));
    assert.notEqual(source, official.get("0.2.1-rc.2"), "the negative fixture must actually differ");
    assert.deepEqual(applyReplacementsToText(source, patch), { text: source, changed: false });
    assert.equal(hostPromptKeepsInject(source), false, "do not approve a host with the original inject-dropping branch");
  });
}

test("the host guard still rejects empty, unrelated, or identity-bearing source", () => {
  const patched = applyReplacementsToText(official.get("0.2.1-rc.2"), patch).text;
  for (const source of ["", "export default {};", `// You are an AI agent powered by DeepSeek Harness.\n${patched}`]) {
    assert.equal(hostPromptKeepsInject(source), false);
  }
});
