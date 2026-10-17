import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installAssembleGuard, overlayOfficialIdentity, rewritePromptAssembly } from "../lib/identity.js";
import {
  renderPrompt,
  renderContextSections,
  renderContextSnapshot,
} from "./fixtures/system-prompt-0.2.1-rc.2-renderer.mjs";

// Execute the real rewrite and the unmodified official strict renderer. These
// tests do not discover an installed host, access an account, or change a prompt
// file. The immutable context fixtures represent facts supplied by the host.
const VARIABLES = Object.freeze({ provider: "fixture-provider", model: "fixture-model" });
const OLD_SUFFIX = "Your working directory is {{cwd}}.";
const INJECT = "Respond clearly to the user's request.";
const OPTIONS = Object.freeze({
  fallbackInject: INJECT,
  dropPurgeAfterFold: false,
  capabilityProtocol: false,
});
const freezeEntries = (entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));
const assembly = (sections, variables = VARIABLES, contexts = freezeEntries([])) => Object.freeze({
  sections: freezeEntries(sections),
  contexts,
  tools: freezeEntries([{ name: "fixture-tool" }]),
  variables,
  extension: "preserve assembly metadata",
});
const rewrite = (input) => rewritePromptAssembly(input, OPTIONS);
const sectionText = (result, name) => result.sections.find((section) => section.name === name)?.text;

test("official renderer reproduces the reported error; the rewritten assembly renders normally", () => {
  const input = assembly([{ name: "deployment:persona-suffix", text: OLD_SUFFIX }]);
  assert.throws(() => renderPrompt(input), {
    message: 'unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model',
  });
  const result = rewrite(input);
  assert.equal(renderPrompt(result), INJECT);
  assert.equal(input.sections[0].text, OLD_SUFFIX, "do not mutate a reused host assembly");
  assert.equal(result.variables, VARIABLES);
  assert.equal(Object.hasOwn(result.variables, "cwd"), false, "do not fabricate or register a global cwd");
});

test("the actual shipped bundle persona suffix renders with the 0.2.1 provider/model variables", () => {
  const bundle = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  const match = /^\s+personaSuffix:[ \t]*(.*)$/m.exec(bundle);
  assert.ok(match, "the real bundle must explicitly declare its persona suffix");
  const scalar = match[1].trim();
  // This one bundle scalar is deliberately limited to a plain string or empty
  // quotes. Reject unsupported YAML forms instead of guessing at their value.
  assert.ok(!/^[|>]/.test(scalar), "update this reader if the bundle adopts block YAML");
  const suffix = scalar === '""' || scalar === "''" ? "" : scalar;
  const input = assembly([{ name: "deployment:persona-suffix", text: suffix }]);
  assert.doesNotThrow(() => renderPrompt(input), "the configuration itself must not require the removed cwd variable");
  assert.equal(renderPrompt(rewrite(input)), INJECT);
});

for (const sections of [[], [{ name: "deployment:persona-suffix", text: "" }]]) {
  test(`provider/model-only assembly with ${sections.length ? "an empty" : "no"} suffix does not acquire a cwd template`, () => {
    const result = rewrite(assembly(sections));
    assert.equal(renderPrompt(result), INJECT);
    assert.ok(result.sections.every((section) => !section.text.includes("{{cwd}}")));
  });
}

for (const name of [
  "deployment:persona-prefix", "persona-prefix", "deployment:persona", "persona",
  "deployment:persona-suffix", "persona-suffix",
]) {
  for (const clause of [OLD_SUFFIX, "Working directory: {{cwd}}."]) {
    test(`remove only a legacy cwd clause in ${name}: ${clause}`, () => {
      const before = "Please answer in Traditional Chinese.";
      const after = "Keep replies brief. Provider: {{provider}}. Model: {{model}}.";
      const input = assembly([{ name, text: `${before}\n${clause}\n${after}`, metadata: "keep" }]);
      const result = rewrite(input);
      const text = sectionText(result, name);
      assert.ok(text.includes(before));
      assert.ok(text.includes(after), "custom text and supported variable references remain unchanged");
      assert.ok(!text.includes(clause));
      assert.equal(result.sections.find((section) => section.name === name).metadata, "keep");
      const rendered = renderPrompt(result);
      assert.ok(rendered.includes(before));
      assert.ok(rendered.includes("Provider: fixture-provider. Model: fixture-model."));
    });
  }
}

test("missing and undefined own cwd, including an inherited cwd, are not available prompt variables", () => {
  const inherited = Object.freeze(Object.assign(Object.create({ cwd: "C:\\wrong-parent" }), VARIABLES));
  for (const variables of [VARIABLES, Object.freeze({ ...VARIABLES, cwd: undefined }), inherited]) {
    const input = assembly([{ name: "deployment:persona-suffix", text: OLD_SUFFIX }], variables);
    const result = rewrite(input);
    assert.equal(result.variables, variables);
    assert.equal(renderPrompt(result), INJECT);
    assert.ok(!result.sections.some((section) => section.text.includes("wrong-parent")));
  }
});

test("custom unknown variables and unrecognized cwd prose retain official strict errors", () => {
  for (const [text, variable] of [
    ["My project root is {{cwd}}.", "cwd"],
    ["Use tenant {{tenant}}.", "tenant"],
  ]) {
    const result = rewrite(assembly([{ name: "deployment:persona-suffix", text }]));
    assert.equal(sectionText(result, "deployment:persona-suffix"), text);
    assert.throws(() => renderPrompt(result), {
      message: `unknown prompt variable "{{${variable}}}" in section "deployment:persona-suffix"; registered variables: provider, model`,
    });
  }
});

test("a non-persona section using cwd still fails instead of being globally rewritten", () => {
  const input = assembly([{ name: "custom-plugin:instructions", text: OLD_SUFFIX }]);
  const result = rewrite(input);
  assert.equal(sectionText(result, "custom-plugin:instructions"), OLD_SUFFIX);
  assert.throws(() => renderPrompt(result), /unknown prompt variable.*cwd.*custom-plugin:instructions/);
});

test("literal persona contributions preserve cwd references through the complete rewrite pipeline", () => {
  const text = `Literal example:\n${OLD_SUFFIX}\nWorking directory: {{cwd}}.\nKeep {{tenant}} literal too.`;
  for (const name of ["deployment:persona-prefix", "deployment:persona", "deployment:persona-suffix"]) {
    const result = rewrite(assembly([{ name, text, interpolate: false }]));
    assert.equal(sectionText(result, name), text);
    assert.ok(renderPrompt(result).includes(text));
  }
});

test("legacy assemblies with a defined own cwd keep their working-directory suffix", () => {
  const cwd = "C:\\Projects\\{{model}}\\legacy";
  const variables = Object.freeze({ ...VARIABLES, cwd });
  for (const sections of [[], [{ name: "deployment:persona-suffix", text: "" }], [{ name: "deployment:persona-suffix", text: OLD_SUFFIX }]]) {
    const result = rewrite(assembly(sections, variables));
    assert.equal(sectionText(result, "deployment:persona-suffix"), OLD_SUFFIX);
    assert.ok(renderPrompt(result).includes(`Your working directory is ${cwd}.`));
    assert.ok(!renderPrompt(result).includes("Projects\\fixture-model"), "official substitution does not recursively interpolate variable values");
  }
});

test("required working-directory context stays literal and refreshes per assembly without entering the header", () => {
  for (const cwd of ["C:\\Projects\\{{model}}\\one", "D:\\Different workspace\\two"]) {
    const context = Object.freeze({
      name: "working-directory:current",
      text: `Current working directory: ${JSON.stringify(cwd)}.`,
      interpolate: false,
      required: true,
    });
    const contexts = Object.freeze([context]);
    const input = assembly([{ name: "deployment:persona-suffix", text: OLD_SUFFIX }], VARIABLES, contexts);
    const result = rewrite(input);
    assert.equal(result.contexts, contexts);
    assert.equal(result.contexts[0], context, "preserve the host's context object and metadata");
    assert.equal(result.variables, VARIABLES);
    assert.equal(renderPrompt(result), INJECT, "the cacheable header never embeds a session directory");
    assert.deepEqual(renderContextSections(result), [{ name: context.name, text: context.text }]);
    assert.equal(renderContextSnapshot(result), `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${context.text}`);
  }
});

test("rewriting frozen inputs is idempotent and preserves variables, context, tools, and extension data", () => {
  const input = assembly([{ name: "deployment:persona-suffix", text: `Keep this custom text.\n${OLD_SUFFIX}` }]);
  const first = rewrite(input);
  const second = rewrite(Object.freeze({ ...first, sections: freezeEntries(first.sections) }));
  assert.deepEqual(second, first);
  assert.equal(first.variables, input.variables);
  assert.equal(first.contexts, input.contexts);
  assert.equal(first.tools, input.tools);
  assert.equal(first.extension, input.extension);
  assert.equal(input.sections[0].text, `Keep this custom text.\n${OLD_SUFFIX}`);
  assert.doesNotThrow(() => renderPrompt(second));
});

test("the installed assembly guard feeds actual per-call variables into rewrite before official rendering", async () => {
  let active = assembly([{ name: "deployment:persona-suffix", text: OLD_SUFFIX }]);
  const prompt = { async assemble() { return active; } };
  let rewrites = 0;
  const dispose = installAssembleGuard(prompt, (value) => { rewrites += 1; return rewrite(value); });
  assert.equal(typeof dispose, "function");
  assert.equal(renderPrompt(await prompt.assemble()), INJECT);
  active = assembly([], Object.freeze({ ...VARIABLES, cwd: "C:\\legacy-session" }));
  assert.ok(renderPrompt(await prompt.assemble()).includes("C:\\legacy-session"));
  active = assembly([{ name: "deployment:persona-suffix", text: OLD_SUFFIX }]);
  assert.equal(renderPrompt(await prompt.assemble()), INJECT, "do not reuse a prior session's cwd availability");
  assert.equal(rewrites, 3);
});

test("standalone identity overlay defaults to the current no-cwd behavior", () => {
  const sections = freezeEntries([{ name: "deployment:persona-suffix", text: OLD_SUFFIX }]);
  const result = overlayOfficialIdentity(sections);
  assert.doesNotThrow(() => renderPrompt({ sections: result, variables: VARIABLES }));
  assert.equal(sections[0].text, OLD_SUFFIX);
});
