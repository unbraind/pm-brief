import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { PmClient, locateItem, readSettings, writeSettings, resolveRuntimeStatusRegistry, evaluateWorkflowPolicies, createLifecycleCompletenessPolicies, estimatePmOutputTokens } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildActionPrerequisiteBrief, parseActionPrerequisiteRequest, ActionPrerequisiteError } from "../index.ts";
import type { ActionPrerequisiteBrief, ActionPrerequisiteRequest } from "../index.ts";

const root = resolve(import.meta.dirname, "..");
/** A real native non-git workspace, with explicit absent relationships on every creation. */
async function fixture(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "brief-action-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const pmRoot = join(workspace, ".agents/pm"); const client = new PmClient({ pmRoot, noExtensions: true, author: "fixture" });
  await client.init("action", { defaults: true, agentGuidance: "skip", mergeFence: false });
  const create = async (title: string, extra: Parameters<PmClient["create"]>[0] = {}) => (await client.create({ title, type: "Task", parent: "none", sprint: "none", release: "none", ...(extra.dep ? {} : { clearDeps: true }), ...extra })).item.id;
  const item = await create("Selected native action", { resolution: "Recorded large evidence. ".repeat(400), expectedResult: "Expected outcome" });
  return { workspace, pmRoot, client, item, create, options: { pmRoot, client } };
}
/** Hash all files; native derived read caches may be excluded explicitly on a cold tracker. */
async function snapshot(path: string, prefix = "", includeRuntime = false): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!includeRuntime && prefix === "" && entry.name === "runtime") continue;
    const ref = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(join(path, entry.name), ref + "/", includeRuntime));
    else if (!entry.isSymbolicLink()) result[ref] = createHash("sha256").update(await readFile(join(path, entry.name))).digest("hex");
  }
  return result;
}
/** Typed safe refusals never lose their remedy. */
function refusal(code: string) {
  return (error: unknown): boolean => { assert.ok(error instanceof ActionPrerequisiteError); assert.equal(error.code, code); assert.ok(error.remedy.length > 10); return true; };
}

test("one preview combines missing close inputs, reverse/missing/external prerequisites and reference-only evidence without mutations", async t => {
  const f = await fixture(t);
  const blocker = await f.create("Unfinished prerequisite", { dep: [`id=${f.item},kind=blocks`] });
  await f.client.update(f.item, { dep: ["id=action-missing,kind=blocked_by", "id=https://example.com/review/1,kind=blocked_by,source_kind=external"], allowUnresolvedDeps: true, parent: "none", sprint: "none", release: "none" });
  await f.client.docs(f.item, { add: ["path=docs/result.md"] });
  await f.client.files(f.item, { add: ["path=action.ts"] });
  await f.client.run("test", { id: f.item, options: { add: ["command=node --version"] } });
  const before = await snapshot(f.pmRoot);
  const result = await buildActionPrerequisiteBrief({ command: "close", item: f.item, requiredEvidence: [{ kind: "docs", ref: "docs/result.md" }, { kind: "files", ref: "action.ts" }, { kind: "tests", ref: "node --version" }, { kind: "docs", ref: "docs/missing.md" }] }, f.options);
  assert.equal(result.ready, false);
  assert.deepEqual(result.checklist.filter(row => row.kind === "input" && row.state === "missing").map(row => row.key), ["actual_result", "reason"]);
  assert.ok(result.checklist.some(row => row.key === blocker && row.state === "unresolved"));
  assert.ok(result.checklist.some(row => row.key === "action-missing" && row.state === "unresolved"));
  assert.equal(result.checklist.filter(row => row.kind === "evidence" && row.state === "satisfied").length, 3);
  assert.equal(result.checklist.filter(row => row.kind === "evidence" && row.state === "missing").length, 1);
  assert.ok(!JSON.stringify(result).includes("Recorded large evidence"));
  assert.match(result.item.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(await snapshot(f.pmRoot), before);
  const warm = await snapshot(f.pmRoot, "", true);
  await buildActionPrerequisiteBrief({ command: "close", item: f.item }, f.options);
  assert.deepEqual(await snapshot(f.pmRoot, "", true), warm);
});

test("prospective fields satisfy native policies and reason precedence without duplicating bodies or shared requirements", async t => {
  const f = await fixture(t);
  await f.client.workflowPolicy("policy-put", "extra-close", { definition: { id: "extra-close", subject: { operations: ["close"] }, rule: { kind: "require_fields", fields: ["resolution", "close_reason", "body"] } } });
  const result = await buildActionPrerequisiteBrief({ command: "close", item: f.item, input: { reason: "Explicit close reason", actualResult: "Observed outcome", resolution: "New supplied resolution", expectedResult: "\r\n New expected result \r\n" } }, f.options);
  assert.equal(result.checklist.filter(row => row.key === "resolution").length, 1);
  assert.equal(result.checklist.find(row => row.key === "reason")?.ref, "request#/input/reason");
  assert.equal(result.checklist.find(row => row.key === "actual_result")?.ref, "request#/input/actualResult");
  assert.equal(result.checklist.find(row => row.key === "close_reason")?.state, "satisfied");
  assert.equal(result.checklist.find(row => row.key === "close_reason")?.ref, "request#/input/reason");
  assert.equal(result.checklist.find(row => row.key === "body")?.state, "missing");
  const complete = await buildActionPrerequisiteBrief({ command: "close", item: f.item, input: { resolution: "New supplied resolution", actualResult: "Observed" } }, f.options);
  assert.equal(complete.checklist.find(row => row.key === "reason")?.ref, "request#/input/resolution");
  assert.equal(complete.checklist.find(row => row.key === "close_reason")?.ref, "request#/input/resolution");
  const simple = await f.create("Ready for close", { resolution: "Resolved", actualResult: "Observed", expectedResult: "Expected", body: "Evidence" });
  assert.equal((await buildActionPrerequisiteBrief({ command: "close", item: simple, input: { reason: "Done" } }, { pmRoot: f.pmRoot })).ready, true);
});

test("SDK lifecycle roles and workflow rules govern custom active, blocked, terminal, human, gate and container cases", async t => {
  const f = await fixture(t);
  await f.client.schemaAddStatus("custom-active", { role: ["active"] });
  await f.client.schemaAddStatus("custom-done", { role: ["terminal_done"] });
  await f.client.schemaAddStatus("custom-canceled", { role: ["terminal_canceled"] });
  const terminal = await f.create("Resolved predecessor", { status: "custom-done", closeReason: "Accepted" });
  await f.client.update(f.item, { status: "custom-active", dep: [`id=${terminal},kind=blocked_by`], parent: "none", sprint: "none", release: "none" });
  let result = await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options);
  assert.equal(result.ready, true, JSON.stringify(result)); assert.ok(result.item.roles.includes("active"));
  assert.equal(result.checklist.find(row => row.key === terminal)?.state, "satisfied");
  const child = await f.create("Open child", { parent: f.item });
  assert.ok((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options)).checklist.some(row => row.key === "active-children"));
  result = await buildActionPrerequisiteBrief({ command: "close", item: f.item }, f.options);
  assert.ok(result.checklist.some(row => row.kind === "prerequisite" && row.key === child));
  await f.client.update(child, { status: "custom-canceled", closeReason: "Canceled", parent: f.item, sprint: "none", release: "none" });
  assert.ok(!(await buildActionPrerequisiteBrief({ command: "close", item: f.item }, f.options)).checklist.some(row => row.key === child));
  await f.client.update(f.item, { status: "blocked", blockedReason: "Pending review", parent: "none", sprint: "none", release: "none" });
  assert.ok((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options)).checklist.some(row => row.key === "blocked-status"));
  for (const type of ["Decision", "Milestone"]) {
    const id = await f.create(`Review ${type}`, { type });
    assert.ok((await buildActionPrerequisiteBrief({ command: "start-task", item: id }, f.options)).checklist.some(row => row.key === (type === "Decision" ? "human-decision" : "outcome-gate")));
  }
  assert.ok((await buildActionPrerequisiteBrief({ command: "close", item: terminal }, f.options)).checklist.some(row => row.key === "inactive"));
  assert.ok((await buildActionPrerequisiteBrief({ command: "start-task", item: terminal }, f.options)).checklist.some(row => row.key === "inactive"));
  await f.client.claim(f.item, { author: "peer" });
  assert.ok((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item, actor: "fixture" }, f.options)).checklist.some(row => row.key === "ownership"));
});

test("selected close admission does not inherit work-dispatch role or active-status restrictions", async t => {
  const f = await fixture(t);
  await f.client.schemaAddStatus("custom-draft", { role: ["draft"] });
  for (const [type, status] of [["Decision", "open"], ["Milestone", "open"], ["Task", "blocked"], ["Task", "custom-draft"]]) {
    const id = await f.create(`Complete ${type} from ${status}`, { type, status, body: "Reviewed evidence", description: "Reviewed work", resolution: "Resolved", expectedResult: "Expected", actualResult: "Observed" });
    const preview = await buildActionPrerequisiteBrief({ command: "close", item: id, input: { reason: "Reviewed completion" } }, f.options);
    assert.equal(preview.ready, true, JSON.stringify(preview));
    assert.ok(!preview.checklist.some(row => ["human-decision", "outcome-gate", "inactive", "blocked-status"].includes(row.key)));
    const child = await f.create(`Unfinished child of ${type}`, { parent: id });
    assert.ok((await buildActionPrerequisiteBrief({ command: "close", item: id }, f.options)).checklist.some(row => row.kind === "prerequisite" && row.key === child));
  }
});

test("unsupported commands and approval capabilities remain visible beside known prerequisites", async t => {
  const f = await fixture(t);
  for (const command of ["get", "not-real", "close-task"]) {
    const result = await buildActionPrerequisiteBrief({ command, item: f.item, input: { reason: "Ignored?" } }, f.options);
    assert.equal(result.ready, false); assert.equal(result.refusals[0].code, "unsupported"); assert.equal(result.refusals[0].capability, "command");
  }
  await f.client.workflowPolicy("policy-put", "review", { definition: { id: "review", subject: { operations: ["close"] }, rule: { kind: "approval", fields: ["resolution"], authors: ["reviewer"] } } });
  await f.client.workflowPolicy("policy-put", "actor", { definition: { id: "actor", rule: { kind: "authors", authors: ["fixture"] } } });
  await f.client.workflowPolicy("policy-put", "create-only", { definition: { id: "create-only", subject: { operations: ["create"] }, rule: { kind: "require_fields", fields: ["body"] } } });
  const result = await buildActionPrerequisiteBrief({ command: "close", item: f.item }, f.options);
  assert.ok(result.refusals.some(row => row.capability === "policy:review")); assert.ok(result.checklist.some(row => row.key === "actor"));
  const allowedActor = await buildActionPrerequisiteBrief({ command: "close", item: f.item, actor: "fixture" }, f.options);
  assert.equal(allowedActor.checklist.find(row => row.kind === "policy" && row.key === "actor")?.state, "satisfied");
});

test("native workflow transition and optional reason governance remain authoritative", async t => {
  const f = await fixture(t);
  await f.client.config("project", "set", "governance_workflow_enforcement", "strict");
  await f.client.config("project", "set", "governance_require_close_reason", "disabled");
  const settings = await readSettings(f.pmRoot);
  await writeSettings(f.pmRoot, { ...settings, schema: { ...settings.schema, type_workflows: [{ type: "Task", allowed_transitions: [] }] } });
  const result = await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options);
  assert.ok(result.checklist.some(row => row.key === "transition"), JSON.stringify(result));
  const close = await buildActionPrerequisiteBrief({ command: "close", item: f.item }, f.options);
  assert.ok(!close.checklist.some(row => row.key === "reason"));
  await writeSettings(f.pmRoot, { ...settings, schema: { ...settings.schema, type_workflows: [{ type: "Task", allowed_transitions: [["open", "in_progress"]] }] } });
  assert.ok(!(await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options)).checklist.some(row => row.key === "transition"));
});

test("competing native writes at either corpus-read boundary cause a typed retry rather than a stale checklist", async t => {
  const f = await fixture(t);
  for (const boundary of [1, 2]) {
    let reads = 0;
    const realRead = f.client.listAllComplete.bind(f.client);
    // Instrument the real SDK transport; all results and competing writes remain native.
    const competing = new PmClient({ pmRoot: f.pmRoot, author: "fixture", noExtensions: true });
    const original = competing.listAllComplete.bind(competing);
    competing.listAllComplete = async options => {
      reads++;
      if (boundary === 2 && reads === 2) await f.client.update(f.item, { description: "Peer changed second boundary", parent: "none", sprint: "none", release: "none" });
      const result = await original(options);
      if (boundary === 1 && reads === 1) await f.client.update(f.item, { description: "Peer changed first boundary", parent: "none", sprint: "none", release: "none" });
      return result;
    };
    await assert.rejects(buildActionPrerequisiteBrief({ command: "close", item: f.item }, { pmRoot: f.pmRoot, client: competing }), refusal("changed"));
    const current = (await realRead({ includeBody: true })).items.find(row => row.id === f.item)!;
    const preview = await buildActionPrerequisiteBrief({ command: "close", item: f.item }, f.options);
    assert.equal(preview.item.revision, createHash("sha256").update(JSON.stringify(current)).digest("hex"));
  }
});

test("one strict request schema rejects sparse arrays, nonfinite/extreme numbers, unknown keys and malformed nested records", async t => {
  const f = await fixture(t); const valid = { command: "close", item: f.item };
  const invalid: unknown[] = [null, [], 1, new Date(), {}, { ...valid, extra: true }, { ...valid, command: "close;bad" }, { ...valid, command: "x".repeat(81) }, { ...valid, item: "../escape" }, { ...valid, actor: " " }, { ...valid, actor: "x\0y" }, { ...valid, input: [] }, { ...valid, input: { extra: "bad" } }, { ...valid, input: { resolution: 1 } }, { ...valid, input: { reason: "x".repeat(16001) } }, { ...valid, input: { reason: "\0" } }, { ...valid, requiredEvidence: new Array(1) }, { ...valid, requiredEvidence: [null] }, { ...valid, requiredEvidence: [{ kind: "docs", ref: "x", extra: true }] }, { ...valid, requiredEvidence: [{ kind: "wrong", ref: "x" }] }, { ...valid, requiredEvidence: [{ kind: "docs", ref: "" }] }, { ...valid, requiredEvidence: [{ kind: "docs", ref: "x" }, { kind: "docs", ref: "x" }] }, { ...valid, requiredEvidence: Array.from({ length: 65 }, (_, i) => ({ kind: "docs", ref: String(i) })) }];
  for (const tokenBudget of [NaN, Infinity, -Infinity, -1, 0, 1.1, 64001, Number.MAX_VALUE, "4000", null]) invalid.push({ ...valid, tokenBudget });
  const symbolic = { ...valid, [Symbol("unknown")]: true }; invalid.push(symbolic);
  for (const input of invalid) {
    assert.throws(() => parseActionPrerequisiteRequest(input), refusal("invalid"));
    await assert.rejects(buildActionPrerequisiteBrief(input as ActionPrerequisiteRequest, { pmRoot: "unreadable-before-validation" }), refusal("invalid"));
  }
  const parsed = parseActionPrerequisiteRequest({ ...valid, input: { reason: " \r\n " }, requiredEvidence: [] });
  assert.equal(parsed.tokenBudget, 4000); assert.deepEqual(parseActionPrerequisiteRequest(parsed), parsed);
  await assert.rejects(buildActionPrerequisiteBrief({ ...valid, item: "action-absent" }, f.options), refusal("missing"));
  await assert.rejects(buildActionPrerequisiteBrief({ ...valid, tokenBudget: 1 }, f.options), refusal("budget"));
  const full = await buildActionPrerequisiteBrief(valid, f.options);
  assert.deepEqual(await buildActionPrerequisiteBrief({ ...valid, tokenBudget: full.estimatedTokenCeiling }, f.options), full);
  assert.ok(estimatePmOutputTokens(Buffer.byteLength(JSON.stringify(full, null, 2))) <= full.estimatedTokenCeiling);
  const located = await locateItem(f.pmRoot, f.item); assert.ok(located);
  await writeFile(located.itemPath, "not an item");
  await assert.rejects(buildActionPrerequisiteBrief(valid, f.options), refusal("tracker"));
});

test("seeded 500 operation sequences replay old requests across whitespace, fields, relationships and random custom status registries", { timeout: 300000 }, async t => {
  const f = await fixture(t);
  let seed = 0x5eed2026;
  const random = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  const roles = ["active", "blocked", "terminal_done", "terminal_canceled"] as const;
  const statuses: string[] = [];
  for (let i = 0; i < 12; i++) { const status = `state-${random(100000)}-${i}`; await f.client.schemaAddStatus(status, { role: [roles[random(roles.length)]] }); statuses.push(status); }
  const predecessor = await f.create("Model predecessor");
  const oldRequests: ActionPrerequisiteRequest[] = [];
  const fields = ["resolution", "expectedResult", "actualResult"] as const;
  const values = ["   \r\n ", "Observed.\r\nSecond line. 測定😀", " Old replay input ", ""];
  const nativeFields = ["resolution", "expected_result", "actual_result"];
  const registry = resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema);
  const preset = createLifecycleCompletenessPolicies().policies.find(row => row.id === "completeness-resolution")!;
  let priorRevision = "";
  for (let sequence = 0; sequence < 500; sequence++) {
    const status = statuses[random(statuses.length)];
    const field = fields[random(fields.length)]; const fieldValue = values[random(values.length)];
    if (sequence % 8 === 0) {
      await f.client.update(predecessor, { status, closeReason: "Model lifecycle", parent: "none", sprint: "none", release: "none" });
      await f.client.focus(predecessor);
      await f.client.update(f.item, { [field]: fieldValue, dep: [`id=${predecessor},kind=blocked_by`], parent: "none", sprint: "none", release: "none" });
    }
    const current = (await f.client.get(f.item, { full: true })).item;
    const request: ActionPrerequisiteRequest = { command: "close", item: f.item, input: { [fields[random(fields.length)]]: values[random(values.length)] }, tokenBudget: 64000 };
    oldRequests.push(request);
    // A saved request is only input: replay it against the current SDK target, never a frozen result.
    const replay = oldRequests[random(oldRequests.length)];
    const before = await snapshot(f.pmRoot);
    const result = await buildActionPrerequisiteBrief(replay, f.options);
    const after: Record<string, unknown> = { ...current, status: registry.close_status };
    for (let i = 0; i < fields.length; i++) {
      const proposed = replay.input?.[fields[i]];
      // SDK evaluator is the reference for blank/CRLF semantics; no handwritten normalizer.
      const decision = evaluateWorkflowPolicies({ version: 1, enforcement: "advise", policies: [{ id: "value", rule: { kind: "require_fields", fields: ["value"] } }] }, { operation: "close", author: "fixture", before: null, after: { value: proposed } });
      if (proposed !== undefined && decision.decisions[0].satisfied) after[nativeFields[i]] = proposed;
    }
    const expected = evaluateWorkflowPolicies({ version: 1, enforcement: "advise", policies: [{ ...preset, subject: { operations: ["close"] } }] }, { operation: "close", author: "fixture", before: current, after });
    assert.deepEqual(result.checklist.filter(row => row.kind === "input" && row.state === "missing" && row.key !== "reason").map(row => row.key), expected.decisions[0].missing_fields, `sequence ${sequence}`);
    const predecessorState = (await f.client.get(predecessor, { full: true })).item;
    assert.equal(result.checklist.find(row => row.key === predecessor)?.state, registry.terminal_statuses.has(predecessorState.status!) ? "satisfied" : "unresolved");
    assert.deepEqual((await f.client.get(f.item, { full: true })).item, current);
    assert.deepEqual(await snapshot(f.pmRoot), before);
    assert.ok(Number.isSafeInteger(result.estimatedTokenCeiling) && result.estimatedTokenCeiling > 0 && result.estimatedTokenCeiling <= 64000);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    priorRevision = result.item.revision;
  }
  assert.match(priorRevision, /^[a-f0-9]{64}$/);
});

test("native non-git CLI and injected command emit bounded JSON/TOON and typed usage refusals", async t => {
  const f = await fixture(t);
  const extensionRoot = join(f.pmRoot, "extensions/pm-brief"); await mkdir(extensionRoot, { recursive: true });
  for (const file of ["manifest.json", "package.json"]) await cp(join(root, file), join(extensionRoot, file));
  await cp(join(root, "dist"), join(extensionRoot, "dist"), { recursive: true }); await symlink(join(root, "node_modules"), join(extensionRoot, "node_modules"));
  await mkdir(join(f.workspace, "bin")); await symlink(process.execPath, join(f.workspace, "bin/node")); await mkdir(join(f.workspace, "home"));
  const run = (args: string[]) => spawnSync(process.execPath, [join(root, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", f.pmRoot, ...args], { cwd: f.workspace, env: { ...process.env, PATH: join(f.workspace, "bin"), GIT_CEILING_DIRECTORIES: dirname(f.workspace), HOME: join(f.workspace, "home") }, encoding: "utf8", timeout: 30000 });
  const before = await snapshot(f.pmRoot);
  for (const format of ["json", "toon"]) {
    const result = run([...(format === "json" ? ["--json"] : []), "brief", "action", "close", f.item, "--request", JSON.stringify({ input: { reason: "Reviewed" } })]);
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /pm-brief.action\/v1/); assert.equal(result.stderr, "");
    assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= 4000);
  }
  for (const args of [["close"], ["close", f.item, "--request", "["], ["close", f.item, "--request", '{"command":"close"}'], ["close", f.item, "--token-budget", "Infinity"], ["close", f.item, "--token-budget", "1"]]) {
    const result = run(["--json", "brief", "action", ...args]); assert.equal(result.status, 2); assert.match(result.stdout + result.stderr, /action_(invalid|budget)|missing_required_argument/);
  }
  assert.deepEqual(await snapshot(f.pmRoot), before);
  const harness = await createExtensionTestHarness(extension, { name: "pm-brief", capabilities: ["commands", "services", "schema"] });
  t.after(() => harness.deactivate());
  const registered = await harness.runCommand({ command: "brief action", args: ["start-task", f.item], pmRoot: f.pmRoot });
  assert.equal((registered.result as ActionPrerequisiteBrief).ready, true);
  const requested = await harness.runCommand({ command: "brief action", args: ["close", f.item], pmRoot: f.pmRoot, options: { request: '{"input":{"reason":"Reviewed"}}', tokenBudget: "4000" } });
  assert.ok((requested.result as ActionPrerequisiteBrief).checklist.some(row => row.key === "reason" && row.state === "satisfied"));
  for (const options of [{ request: "[" }, { request: 1 }, { request: "x".repeat(196609) }, { tokenBudget: 4000 }, { tokenBudget: "1" }, { request: '{"command":"close"}' }, { request: '{"item":"action-foreign"}' }, { request: '{"tokenBudget":10}' }]) await assert.rejects(harness.runCommand({ command: "brief action", args: ["close", f.item], pmRoot: f.pmRoot, options }), /action (invalid|budget)/);
  await assert.rejects(harness.runCommand({ command: "brief action", args: ["close"], pmRoot: f.pmRoot }), /action invalid/);
});
