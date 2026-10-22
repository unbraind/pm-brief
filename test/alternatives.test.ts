import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { PmClient, locateItem, estimatePmOutputTokens } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildDecisionAlternatives, DecisionAlternativesError } from "../index.ts";
import type { DecisionAlternativesDigest } from "../index.ts";

const root = resolve(import.meta.dirname, "..");
const workspace = await mkdtemp(join(tmpdir(), "brief-alternatives-"));
const pmRoot = join(workspace, ".agents/pm");
const client = new PmClient({ pmRoot, author: "fixture", noExtensions: true });
const options = { pmRoot, client, tokenBudget: 64000 };
let first: string; let second: string;

/** Require stable categories and actionable remedies for every expected refusal. */
function refusal(code: string) {
  return (error: unknown): boolean => { assert.ok(error instanceof DecisionAlternativesError); assert.equal(error.code, code); assert.ok(error.remedy.length > 20); return true; };
}
/** Run the installed extension with no git executable or enclosing repository. */
function run(args: string[]) {
  return spawnSync(process.execPath, [join(root, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", pmRoot, ...args], { cwd: workspace, env: { ...process.env, PATH: join(workspace, "bin"), GIT_CEILING_DIRECTORIES: dirname(workspace), HOME: join(workspace, "home") }, encoding: "utf8", timeout: 180000 });
}

before(async () => {
  await mkdir(join(workspace, "bin")); await symlink(process.execPath, join(workspace, "bin/node")); await mkdir(join(workspace, "home"));
  await client.init("alternatives", { defaults: true, agentGuidance: "skip", mergeFence: false });
  first = (await client.create({ type: "Plan", title: "Keep the cache", body: "Retain the cache. Its latency is lower.\n\nUnresolved: eviction complexity.\n\n" + "Long optional evidence. ".repeat(1200) })).item.id;
  second = (await client.create({ type: "Decision", title: "Remove the cache", body: "Remove the cache. Its maintenance is costly.\r\n\r\nUnresolved: cold-start latency. 測定😀", blockedReason: "Latency measurements are missing" })).item.id;
  await client.planDecision(first, { decisionText: "Keep the cache", decisionRationale: "Recorded low latency", decisionEvidence: "docs/latency.md" });
  await client.planDecision(first, { decisionText: "Remove the cache", decisionRationale: "Recorded high complexity" });
  await client.planResume(first, { resumeContext: "Unresolved: compare cold-start measurements" });
  for (const field of ["review_verdict", "review_reason", "review_commit", "review_verdict_source"]) await client.schemaAddField(field, { type: "string" });
  const reviewFields = { reviewVerdict: "refuse", reviewReason: "Missing latency evidence", reviewCommit: "", reviewVerdictSource: "local" };
  await client.update(second, { author: "fixture", ...reviewFields });
  await client.docs(first, { add: ["path=docs/latency.md"] });
  await client.files(second, { add: ["path=cache.ts"] });
  await client.run("test", { id: first, options: { add: ["command=node --version"] } });
  await client.comments(second, { add: "Tradeoff remains unresolved: latency versus complexity.\nMore recorded context." });
  await client.notes(second, { add: "No winner recorded" });
  await client.learnings(second, { add: "Linked evidence alone does not prove success" });
  const extensionRoot = join(pmRoot, "extensions/pm-brief"); await mkdir(extensionRoot, { recursive: true });
  for (const file of ["manifest.json", "package.json"]) await cp(join(root, file), join(extensionRoot, file));
  await cp(join(root, "dist"), join(extensionRoot, "dist"), { recursive: true }); await symlink(join(root, "node_modules"), join(extensionRoot, "node_modules"));
});
after(() => rm(workspace, { recursive: true, force: true }));

test("conflicting recorded outcomes remain separate and every excerpt resolves exactly to its source", async () => {
  const before = (await client.listAllComplete({ includeBody: true })).items;
  const digest = await buildDecisionAlternatives([first, second], options);
  assert.deepEqual(digest.alternatives.map(row => row.id), [first, second]);
  assert.deepEqual(digest.alternatives.map(row => row.omitted), [0, 0]);
  assert.deepEqual(digest.alternatives[0].statements.filter(row => /\/decision$/.test(row.source)).map(row => row.text), ["Keep the cache", "Remove the cache"]);
  assert.ok(digest.alternatives[1].statements.some(row => row.source.endsWith("/review_verdict") && row.text === "refuse"));
  assert.ok(digest.alternatives[1].statements.some(row => row.source.endsWith("/review_reason") && row.text === "Missing latency evidence"));
  for (const alternative of digest.alternatives) {
    assert.match(alternative.revision, /^[a-f0-9]{64}$/);
    assert.equal(alternative.restore, `pm get ${alternative.id} --json --output-budget unbounded --output-limit unbounded`);
    for (const statement of alternative.statements) {
      const [id, pointer] = statement.source.split("#");
      let source: unknown = before.find(row => row.id === id);
      for (const part of pointer.slice(1).split("/")) source = (source as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      assert.equal(String(source).slice(statement.start, statement.end), statement.text);
    }
  }
  assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, before);
  const reversed = await buildDecisionAlternatives([second, first], options);
  assert.deepEqual(reversed.alternatives, [...digest.alternatives].reverse());
});

test("budget includes citations and omissions while retaining mandatory outcomes and unresolved blockers", async () => {
  const digest = await buildDecisionAlternatives([first, second], { pmRoot });
  assert.ok(digest.estimatedTokenCeiling <= 4000);
  assert.ok(digest.alternatives[0].omitted > 0);
  assert.ok(digest.alternatives[0].statements.some(row => row.source.endsWith("/plan_resume_context")));
  assert.ok(digest.alternatives[1].statements.some(row => row.source.endsWith("/blocked_reason")));
  assert.equal(digest.alternatives[0].statements.filter(row => /\/decision$/.test(row.source)).length, 2);
  assert.ok(estimatePmOutputTokens(Buffer.byteLength(JSON.stringify(digest, null, 2))) <= digest.estimatedTokenCeiling);
  const repeated = await buildDecisionAlternatives([first, second], { ...options, tokenBudget: digest.estimatedTokenCeiling });
  assert.deepEqual(repeated, digest);
  await assert.rejects(buildDecisionAlternatives([first, second], { ...options, tokenBudget: 1 }), refusal("budget"));
});

test("malformed selection, missing items and corrupt plain trackers refuse with remedies", async () => {
  for (const ids of [[], [first], [first, first], [first, "../escape"], Array.from({ length: 33 }, (_, i) => `id-${i}`)]) await assert.rejects(buildDecisionAlternatives(ids, options), refusal("invalid"));
  for (const tokenBudget of [0, 1.2, 64001, Number.NaN]) await assert.rejects(buildDecisionAlternatives([first, second], { ...options, tokenBudget }), refusal("invalid"));
  await assert.rejects(buildDecisionAlternatives([first, "absent-item"], options), refusal("missing"));
  const bad = await mkdtemp(join(tmpdir(), "brief-alternatives-bad-"));
  try { await assert.rejects(buildDecisionAlternatives([first, second], { pmRoot: join(bad, ".agents/pm") }), refusal("tracker")); }
  finally { await rm(bad, { recursive: true, force: true }); }
  const located = await locateItem(pmRoot, second); assert.ok(located);
  const saved = await readFile(located.itemPath, "utf8");
  try { await writeFile(located.itemPath, "not a valid item"); await assert.rejects(buildDecisionAlternatives([first, second], options), refusal("tracker")); }
  finally { await writeFile(located.itemPath, saved); }
});

test("empty fields, JSON pointer escaping and numeric evidence retain recorded values", async () => {
  const id = (await client.create({ type: "Task", title: "Empty optional evidence", body: "\n\n" })).item.id;
  const digest = await buildDecisionAlternatives([id, second], options);
  assert.deepEqual(digest.alternatives[0].statements.map(row => row.text), ["Empty optional evidence", "open"]);
  assert.ok((await buildDecisionAlternatives([first, second], options)).alternatives[0].statements.some(row => row.source.includes("/tests/")));
  const scratch = await mkdtemp(join(tmpdir(), "brief-alternatives-json-"));
  const customRoot = join(scratch, ".agents/pm"); const custom = new PmClient({ pmRoot: customRoot, noExtensions: true, author: "fixture" });
  try {
    await custom.init("custom", { defaults: true, agentGuidance: "skip", mergeFence: false });
    await custom.schemaAddField("review_reason", { type: "object" });
    const fields = { reviewReason: JSON.stringify({ z: false, "a/b~": 0, nil: null, empty: "", array: [] }) };
    const a = (await custom.create({ title: "Structured recorded reason", type: "Task", ...fields })).item.id;
    const b = (await custom.create({ title: "Separate alternative", type: "Task" })).item.id;
    const structured = await buildDecisionAlternatives([a, b], { pmRoot: customRoot });
    const statements = structured.alternatives[0].statements;
    assert.ok(statements.some(row => row.source.endsWith("/review_reason/a~1b~0") && row.text === "0"));
    assert.ok(statements.some(row => row.source.endsWith("/review_reason/z") && row.text === "false"));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("real no-git CLI emits bounded native JSON and TOON and nonzero typed refusals", () => {
  for (const format of ["json", "toon"]) {
    const result = run([...(format === "json" ? ["--json"] : []), "brief", "alternatives", first, second]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) < 4000);
    assert.match(result.stdout, /pm-brief.alternatives\/v1/);
    assert.match(result.stdout, /Keep the cache/); assert.match(result.stdout, /Remove the cache/);
    if (format === "json") {
      const digest = JSON.parse(result.stdout) as DecisionAlternativesDigest;
      assert.equal(digest.alternatives.length, 2); assert.ok(digest.alternatives[0].omitted > 0);
      assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= digest.estimatedTokenCeiling);
    }
  }
  for (const args of [[first], [first, "absent-item"], [first, second, "--token-budget", "1"], [first, second, "--token-budget", "no"]]) {
    const result = run(["--json", "brief", "alternatives", ...args]);
    assert.equal(result.status, 2); assert.match(result.stderr + result.stdout, /alternatives_(invalid|missing|budget)/); assert.match(result.stderr + result.stdout, /[Rr]emedy|required/);
  }
});

test("registered SDK command shares the typed selection and budget boundary", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-brief", capabilities: ["commands", "services", "schema"] });
  try {
    const result = await harness.runCommand({ command: "brief alternatives", args: [first, second], pmRoot, options: { tokenBudget: "4000" } });
    assert.equal(result.handled, true, result.errorMessage ?? "Command should succeed"); assert.equal((result.result as DecisionAlternativesDigest).alternatives.length, 2);
    await assert.rejects(harness.runCommand({ command: "brief alternatives", args: [first], pmRoot }), /alternatives invalid/);
  } finally { await harness.deactivate(); }
});
