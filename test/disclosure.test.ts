import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { PmClient, locateItem, estimatePmOutputTokens } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildBrief, buildDisclosureBrief, renderDisclosureBrief, parseDisclosurePolicy, DisclosureError } from "../index.ts";
import type { AgentBrief, DisclosurePolicy, DisclosureResult, DisclosureProfile } from "../index.ts";

const root = resolve(import.meta.dirname, "..");
const workspace = await mkdtemp(join(tmpdir(), "brief-disclosure-"));
const pmRoot = join(workspace, ".agents/pm");
const client = new PmClient({ pmRoot, author: "fixture", noExtensions: true });
const synthetic = `ghp_${"SYNTHETIC".repeat(5)}`;
const forbidden = "FORBIDDEN-CUSTOM-VALUE";
const generatedAt = "2026-10-23T12:00:00.000Z";

/** Assert stable refusals with safe, useful recovery text. */
function refusal(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof DisclosureError); assert.equal(error.code, code); assert.ok(error.remedy.length > 20);
    assert.doesNotMatch(error.message + error.remedy, /FORBIDDEN|SYNTHETIC/); return true;
  };
}
/** A single source brief is reused unchanged for every audience and dry run. */
function source(): AgentBrief {
  const brief = buildBrief([{ id: "fixture-one", title: "Visible release", type: "Task", status: "in_progress", assignee: "internal-actor", tags: ["public-label", synthetic], body: forbidden, private_custom: forbidden }], { generatedAt, pmRoot: "private-tracker", tokenBudget: 64000 });
  return Object.assign(brief, { customer_private: forbidden, [synthetic]: forbidden, recentActivity: [{ timestamp: generatedAt, author: "internal-actor", operation: "comment", itemId: "fixture-one", message: forbidden }] });
}
/** Execute the installed command in a plain directory with no git executable. */
function run(args: string[]) {
  return spawnSync(process.execPath, [join(root, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", pmRoot, ...args], { cwd: workspace, env: { ...process.env, PATH: join(workspace, "bin"), GIT_CEILING_DIRECTORIES: dirname(workspace), HOME: join(workspace, "home") }, encoding: "utf8", timeout: 180000 });
}

before(async () => {
  await mkdir(join(workspace, "bin")); await symlink(process.execPath, join(workspace, "bin/node")); await mkdir(join(workspace, "home"));
  await client.init("disclosure", { defaults: true, agentGuidance: "skip", mergeFence: false });
  await client.schemaAddField("customer_private", { type: "string" });
  const customFields = { customerPrivate: forbidden };
  await client.create({ type: "Task", title: "Visible release", body: forbidden, ...customFields });
  await client.create({ type: "Task", title: synthetic, body: forbidden, ...customFields });
  const extensionRoot = join(pmRoot, "extensions/pm-brief"); await mkdir(extensionRoot, { recursive: true });
  for (const file of ["manifest.json", "package.json"]) await cp(join(root, file), join(extensionRoot, file));
  await cp(join(root, "dist"), join(extensionRoot, "dist"), { recursive: true }); await symlink(join(root, "node_modules"), join(extensionRoot, "node_modules"));
});
after(() => rm(workspace, { recursive: true }));

test("one brief has monotonically narrower profiles with field-level exclusions and no public secrets or custom fields", () => {
  const brief = source(); const saved = JSON.stringify(brief);
  const internal = renderDisclosureBrief(brief, { profile: "internal" });
  const external = renderDisclosureBrief(brief, { profile: "external" });
  const published = renderDisclosureBrief(brief, { profile: "public" });
  assert.match(JSON.stringify(internal.brief), /internal-actor/);
  assert.match(JSON.stringify(external.brief), /public-label/);
  assert.doesNotMatch(JSON.stringify(external.brief), /internal-actor|private-tracker/);
  assert.match(JSON.stringify(published.brief), /Visible release/);
  assert.doesNotMatch(JSON.stringify(published), /FORBIDDEN|SYNTHETIC|customer_private|public-label|internal-actor|private-tracker/);
  assert.equal(published.exclusions.profile["/focus/*/assignee"], 1);
  assert.equal(external.exclusions.secret["/focus/0/tags/1"], 1);
  assert.ok(Object.keys(published.exclusions.unknown_field).some(path => /^\/@\d+$/.test(path)));
  assert.equal(JSON.stringify(brief), saved);
  for (const profile of ["internal", "external", "public"] as const) {
    const value = source(); value.focus[0].title = synthetic;
    const result = renderDisclosureBrief(value, { profile });
    assert.equal(result.exclusions.secret["/focus/0/title"], 1); assert.ok(!JSON.stringify(result).includes(synthetic));
  }
});

test("dry run explains the same exclusions and never returns permitted or forbidden values", () => {
  const brief = source(); const policy: DisclosurePolicy = { profile: "public", exclude: ["focus.*.title", "next.*.title", "focus.*.title"] };
  const rendered = renderDisclosureBrief(brief, policy);
  const preview = renderDisclosureBrief(brief, policy, { dryRun: true });
  assert.equal(preview.brief, undefined); assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.exclusions, rendered.exclusions);
  assert.equal(preview.exclusions.policy["/focus/*/title"], 1);
  assert.doesNotMatch(JSON.stringify(preview), /Visible release|fixture-one|FORBIDDEN|SYNTHETIC|internal-actor/);
  assert.equal(parseDisclosurePolicy(policy).exclude?.length, 2);
});

test("unknown policy keys and selectors fail closed without echoing policy text", async () => {
  for (const policy of [null, [], "public", {}, Object.create({ profile: "public" }) as unknown, Object.defineProperty({ profile: "public" }, "hidden", { value: forbidden }), { profile: "public", [Symbol("hidden")]: forbidden }, { profile: "unknown" }, { profile: "__proto__" }, { profile: "public", allow: [forbidden] }, { profile: "public", [synthetic]: true }, { profile: "public", exclude: [forbidden] }, { profile: "public", exclude: "focus.*.title" }, { profile: "public", exclude: [5] }, { profile: "public", exclude: Array(1000).fill("generatedAt") }]) {
    assert.throws(() => parseDisclosurePolicy(policy), refusal("policy"));
    await assert.rejects(buildDisclosureBrief(policy as DisclosurePolicy, { pmRoot: "unreadable" }), refusal("policy"));
  }
  assert.deepEqual(parseDisclosurePolicy({ profile: "public" }), { profile: "public", exclude: [] });
});

test("unknown nested fields, hostile shapes and recursive values cannot bypass the vocabulary", () => {
  const brief = source();
  Object.assign(brief.focus[0], { [synthetic]: forbidden });
  Object.assign(brief.focus[0], { title: { nested: forbidden }, rankingScore: Number.NaN });
  const published = renderDisclosureBrief(brief, { profile: "public" });
  assert.equal(published.exclusions.invalid_value["/focus/0/title"], 1);
  assert.ok(Object.keys(published.exclusions.unknown_field).some(path => path.startsWith("/focus/0/@")));
  const internal = renderDisclosureBrief(brief, { profile: "internal" }); assert.equal(internal.exclusions.invalid_value["/focus/0/rankingScore"], 1);
  assert.doesNotMatch(JSON.stringify(published), /FORBIDDEN|SYNTHETIC/);
  for (const invalid of [null, [], 1, "value"]) assert.throws(() => renderDisclosureBrief(invalid as unknown as AgentBrief, { profile: "public" }), refusal("invalid"));
  const malformed = Object.assign(source(), { focus: 5, next: null, workspace: [], budget: undefined });
  assert.ok(renderDisclosureBrief(malformed, { profile: "public" }).exclusions.invalid_value["/focus"]);
  const cycle = source(); Object.assign(cycle, { workspace: cycle });
  assert.throws(() => renderDisclosureBrief(cycle, { profile: "public" }), refusal("invalid"));
  const deep = source(); Object.assign(deep, { focus: Array(1).fill(Array(1).fill([])) });
  assert.doesNotMatch(JSON.stringify(renderDisclosureBrief(deep, { profile: "public" })), /FORBIDDEN|SYNTHETIC/);
});

test("all credential classes use the native guard, and policy removal precedes scanning", () => {
  for (const secret of [synthetic, `npm_${"SYNTHETIC".repeat(5)}`, `sk-${"SYNTHETIC".repeat(5)}`, "-----BEGIN PRIVATE KEY-----", "password=synthetic-password"]) {
    const brief = source(); brief.focus[0].title = secret;
    const result = renderDisclosureBrief(brief, { profile: "public" });
    assert.equal(result.exclusions.secret["/focus/0/title"], 1); assert.ok(!JSON.stringify(result).includes(secret));
    const dry = renderDisclosureBrief(brief, { profile: "public", exclude: ["focus.*.title"] }, { dryRun: true });
    assert.equal(dry.exclusions.policy["/focus/*/title"], 1); assert.equal(dry.exclusions.secret["/focus/0/title"], undefined);
  }
});

test("the entire manifest and native framing are budgeted with typed refusals", () => {
  const brief = source(); const result = renderDisclosureBrief(brief, { profile: "internal" });
  assert.ok(estimatePmOutputTokens(Buffer.byteLength(JSON.stringify(result, null, 2))) <= result.estimatedTokenCeiling);
  assert.deepEqual(renderDisclosureBrief(brief, { profile: "internal" }, { tokenBudget: result.estimatedTokenCeiling }), result);
  assert.throws(() => renderDisclosureBrief(brief, { profile: "internal" }, { tokenBudget: 1 }), refusal("budget"));
  for (const tokenBudget of [0, Number.NaN, 1.2, 64001]) assert.throws(() => renderDisclosureBrief(brief, { profile: "public" }, { tokenBudget }), refusal("invalid"));
  assert.throws(() => renderDisclosureBrief(brief, { profile: "public" }, { dryRun: "yes" as unknown as boolean }), refusal("invalid"));
  brief.budget.truncated = true; assert.equal(renderDisclosureBrief(brief, { profile: "public" }).sourceTruncated, true);
});

test("certified SDK read is read-only in a plain tracker and corrupt source refuses", async () => {
  const before = (await client.listAllComplete({ includeBody: true })).items;
  for (const profile of ["public", "external", "internal"] as DisclosureProfile[]) {
    const result = await buildDisclosureBrief({ profile }, { pmRoot, client, generatedAt });
    assert.match(JSON.stringify(result), /Visible release/); assert.ok(!JSON.stringify(result).includes(forbidden));
  }
  assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, before);
  const located = await locateItem(pmRoot, before[0].id); assert.ok(located);
  const saved = await readFile(located.itemPath, "utf8");
  try { await writeFile(located.itemPath, "invalid tracker record"); await assert.rejects(buildDisclosureBrief({ profile: "public" }, { pmRoot }), refusal("tracker")); }
  finally { await writeFile(located.itemPath, saved); }
  const empty = await mkdtemp(join(tmpdir(), "brief-disclosure-empty-"));
  try { await assert.rejects(buildDisclosureBrief({ profile: "public" }, { pmRoot: join(empty, ".agents/pm") }), refusal("tracker")); }
  finally { await rm(empty, { recursive: true }); }
});

test("native source guard removes credentials before truncation and omits secret-bearing identities", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "brief-disclosure-source-"));
  const tracker = join(scratch, ".agents/pm"); const native = new PmClient({ pmRoot: tracker, noExtensions: true, author: "fixture" });
  try {
    await native.init("safe", { defaults: true, agentGuidance: "skip", mergeFence: false });
    await native.create({ type: "Task", title: `${synthetic} ${"Long title ".repeat(2000)}` });
    await native.create({ type: "Task", id: `sk-${"synthetic".repeat(6)}`, title: "Secret identity must be withheld" });
    const result = await buildDisclosureBrief({ profile: "public" }, { pmRoot: tracker });
    const paths = Object.keys(result.exclusions.secret);
    assert.ok(paths.some(path => /^\/source\/\d+\/@\d+$/.test(path)));
    assert.ok(paths.some(path => /^\/source\/\d+$/.test(path)));
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|Secret identity/);
    const preview = await buildDisclosureBrief({ profile: "public" }, { pmRoot: tracker, dryRun: true });
    assert.equal(preview.brief, undefined); assert.deepEqual(preview.exclusions.secret, result.exclusions.secret);
  } finally { await rm(scratch, { recursive: true }); }
});

test("native CLI JSON and TOON work without git and remain inside the measured ceiling", async () => {
  for (const format of ["json", "toon"]) for (const dryRun of [false, true]) {
    const result = run([...(format === "json" ? ["--json"] : []), "brief", "disclose", "--audience", "public", ...(dryRun ? ["--dry-run"] : [])]);
    assert.equal(result.status, 0, result.stderr + result.stdout); assert.equal(result.stderr, "");
    assert.match(result.stdout, /pm-brief.disclosure\/v1/); assert.doesNotMatch(result.stdout, /FORBIDDEN|SYNTHETIC/);
    if (dryRun) assert.ok(!result.stdout.includes("Visible release")); else assert.match(result.stdout, /Visible release/);
    if (format === "json") { const value = JSON.parse(result.stdout) as DisclosureResult; assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= value.estimatedTokenCeiling); }
    assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= 8000);
  }
  const policyPath = join(workspace, "policy.json"); await writeFile(policyPath, JSON.stringify({ profile: "public", exclude: ["next.*.title"] }));
  assert.equal(run(["--json", "brief", "disclose", "--policy", policyPath]).status, 0);
  for (const args of [[], ["--audience", "unknown"], ["--audience", "public", "--policy", policyPath], ["--audience", "public", "extra"], ["--audience", "public", "--token-budget", "1"], ["--audience", "public", "--token-budget", "no"], ["--policy", join(workspace, "absent.json")]]) {
    const result = run(["--json", "brief", "disclose", ...args]);
    assert.equal(result.status, 2, result.stdout + result.stderr); assert.match(result.stdout + result.stderr, /disclosure_(policy|budget|invalid)/); assert.match(result.stdout + result.stderr, /required|Remedy/);
  }
  await writeFile(policyPath, JSON.stringify({ profile: "public", [synthetic]: forbidden }));
  const result = run(["--json", "brief", "disclose", "--policy", policyPath]); assert.equal(result.status, 2); assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN|SYNTHETIC/);
  await writeFile(policyPath, "{invalid json"); assert.equal(run(["brief", "disclose", "--policy", policyPath]).status, 2);
});

test("native command harness retains typed policy, control and tracker refusals", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-brief", capabilities: ["commands", "services", "schema"] });
  try {
    const result = await harness.runCommand({ command: "brief disclose", pmRoot, options: { audience: "public", dryRun: true, tokenBudget: "8000" } });
    assert.equal((result.result as DisclosureResult).dryRun, true);
    const policyPath = join(workspace, "harness-policy.json");
    await writeFile(policyPath, JSON.stringify({ profile: "public", exclude: ["next.*.title"] }));
    const fileResult = await harness.runCommand({ command: "brief disclose", pmRoot, options: { policy: policyPath } });
    assert.equal((fileResult.result as DisclosureResult).profile, "public");
    await writeFile(policyPath, JSON.stringify({ profile: "public", [synthetic]: forbidden }));
    await assert.rejects(harness.runCommand({ command: "brief disclose", pmRoot, options: { policy: policyPath } }), /disclosure policy/);
    await writeFile(policyPath, "{invalid json");
    await assert.rejects(harness.runCommand({ command: "brief disclose", pmRoot, options: { policy: policyPath } }), /disclosure policy/);
    await assert.rejects(harness.runCommand({ command: "brief disclose", pmRoot, options: { policy: `${policyPath}.absent` } }), /disclosure policy/);
    await assert.rejects(harness.runCommand({ command: "brief disclose", pmRoot, options: { audience: "unknown" } }), /disclosure policy/);
    await assert.rejects(harness.runCommand({ command: "brief disclose", pmRoot, options: { audience: "public", dryRun: "yes" } }), /disclosure invalid/);
    const unexpected = DisclosureError.from(new Error(synthetic)); assert.equal(unexpected.code, "tracker"); assert.ok(!JSON.stringify(unexpected).includes(synthetic));
    assert.equal(DisclosureError.from(unexpected), unexpected);
    const scratch = await mkdtemp(join(tmpdir(), "brief-disclosure-harness-"));
    try { await assert.rejects(harness.runCommand({ command: "brief disclose", pmRoot: join(scratch, ".agents/pm"), options: { audience: "public" } }), /disclosure tracker/); }
    finally { await rm(scratch, { recursive: true }); }
  } finally { await harness.deactivate(); }
});
