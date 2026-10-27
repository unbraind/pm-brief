import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { PmClient, locateItem, readSettings, readWorkflowPolicies, writeSettings, resolveRuntimeStatusRegistry, evaluateWorkflowPolicies, createLifecycleCompletenessPolicies, estimatePmOutputTokens, resolveItemTypeRegistry, resolveTypeDefinition, resolveCommandOptionPolicyState, canonicalizeCommandOptionKey, COMMON_MUTATION_COMMAND_OPTION_KEYS, computeActionabilityReport, writeWorkspaceJsonWithHistory, resolveItemTypesFilePath } from "@unbrained/pm-cli/sdk";
import type { WorkflowPolicy } from "@unbrained/pm-cli/sdk";
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

/** Configure native type policies through the SDK while preserving other type definitions. */
async function updatePolicies(pmRoot: string, policies: NonNullable<ReturnType<typeof resolveTypeDefinition>>["command_option_policies"]) {
  const settings = await readSettings(pmRoot);
  const types = Object.values(resolveItemTypeRegistry(settings).by_type).map(type => type.name === "Task" ? { ...type, command_option_policies: policies } : type);
  await writeWorkspaceJsonWithHistory({ pmRoot, filePath: resolveItemTypesFilePath(pmRoot, settings.schema), raw: JSON.stringify({ definitions: types }), op: "schema_update", author: "fixture", lockTtlSeconds: settings.locks.ttl_seconds, lockWaitMs: settings.locks.wait_ms });
}

test("effective policy severity agrees with native admission for every rule, mode, effect and stage", { timeout: 600000 }, async t => {
  const f = await fixture(t);
  const rules: WorkflowPolicy["rule"][] = [
    { kind: "authors", authors: ["reviewer"] }, { kind: "require_fields", fields: ["body"] },
    { kind: "transition", allowed: [] }, { kind: "field_writers", fields: ["status", "assignee"], authors: ["reviewer"] },
    { kind: "approval", fields: ["resolution"], authors: ["reviewer"] },
  ];
  const registry = resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema);
  /** Reuse native state so the severity matrix does not grow a quadratic tracker corpus. */
  const reset = async (): Promise<void> => {
    const current = (await f.client.get(f.item, { full: true })).item;
    if (registry.terminal_statuses.has(current.status!)) await f.client.reopen(f.item, "Next severity case");
    await f.client.update(f.item, { status: registry.open_status, assignee: "none", resolution: "Resolved", expectedResult: "Expected", actualResult: "Observed", parent: "none", sprint: "none", release: "none", clearDeps: true });
  };
  let cases = 0;
  for (const mode of ["refuse", "advise"]) for (const effect of ["refuse", "advise", "warn", undefined] as const) for (const operation of ["claim", "update", "close"]) for (const rule of rules) {
    await f.client.workflowPolicy("policy-remove", "severity-check");
    await reset();
    const id = f.item;
    await f.client.workflowPolicy("policy-mode", mode);
    await f.client.workflowPolicy("policy-put", "severity-check", { definition: { id: "severity-check", ...(effect === undefined ? {} : { effect }), subject: { operations: [operation] }, rule } });
    const nativeBefore = (await f.client.get(id, { full: true })).item;
    const item = (await f.client.listAllComplete({ includeBody: true })).items.find(row => row.id === id)!;
    const after = { ...item, ...(operation === "claim" ? { assignee: "fixture", claim_principal: "fixture" } : { status: operation === "close" ? "closed" : "in_progress" }) };
    const evaluated = evaluateWorkflowPolicies(await readWorkflowPolicies(f.pmRoot), { operation, author: "fixture", before: item, after });
    const decision = evaluated.decisions[0];
    const command = operation === "close" ? "close" : "start-task";
    const request: ActionPrerequisiteRequest = { command, item: id, actor: "fixture", ...(command === "close" ? { input: { reason: "Reviewed" } } : {}) };
    const before = await snapshot(f.pmRoot);
    const preview = await buildActionPrerequisiteBrief(request, f.options);
    assert.equal(preview.ready, decision.effect !== "refuse", `${mode}/${effect}/${operation}/${rule.kind}: ${JSON.stringify(preview)}`);
    assert.deepEqual(await snapshot(f.pmRoot), before);
    assert.deepEqual((await f.client.get(id, { full: true })).item, nativeBefore);
    assert.deepEqual((await f.client.listAllComplete({ includeBody: true })).items.find(row => row.id === id), item);
    if (!evaluated.allowed) await assert.rejects(command === "close" ? f.client.close(id, "Reviewed", { author: "fixture" }) : f.client.startTask(id, { author: "fixture" }), /policy/i, `${mode}/${effect}/${operation}/${rule.kind}`);
    else {
      if (decision.effect !== "refuse") {
        assert.equal(preview.refusals.length, 0);
        assert.ok(preview.checklist.some(row => row.effect === decision.effect && row.blocking === false));
      } else assert.ok(preview.refusals.length, "uncertified refusing policies retain explicit capability refusals");
      const native = command === "close" ? await f.client.close(id, "Reviewed", { author: "fixture" }) : await f.client.startTask(id, { author: "fixture" });
      assert.equal((await f.client.get(id, { full: true })).item.status, "claim" in native ? native.update.item.status : native.item.status);
      if (!decision.satisfied) assert.ok(evaluated.warnings.some(warning => warning.includes("severity-check")));
      // The claim result exposes takeover warnings, not generic policy diagnostics.
      if (operation !== "claim" && evaluated.warnings.length) {
        const warnings = "claim" in native ? native.update.warnings : native.warnings;
        assert.ok(warnings.some(warning => warning.includes("severity-check")));
      }
    }
    cases++;
  }
  await f.client.workflowPolicy("policy-remove", "severity-check");
  await reset();
  await f.client.workflowPolicy("policy-mode", "refuse");
  for (const effect of ["advise", "warn", "refuse"] as const) {
    await f.client.workflowPolicy("policy-put", "actor-needed", { definition: { id: "actor-needed", effect, subject: { operations: ["update"] }, rule: { kind: "authors", authors: ["reviewer"] } } });
    const preview = await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options);
    assert.equal(preview.ready, effect !== "refuse");
    assert.equal(preview.checklist.find(row => row.key === "actor")?.blocking === false, effect !== "refuse");
  }
  await f.client.workflowPolicy("policy-remove", "actor-needed");
  await f.client.workflowPolicy("policy-put", "mandatory", { definition: { id: "mandatory", effect: "refuse", subject: { operations: ["update"] }, rule: rules[0] } });
  await f.client.workflowPolicy("policy-put", "zz-advisory", { definition: { id: "zz-advisory", effect: "advise", subject: { operations: ["update"] }, rule: rules[0] } });
  assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item, actor: "fixture" }, f.options)).ready, false);
  await f.client.workflowPolicy("policy-remove", "mandatory");
  assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item, actor: "fixture", requiredEvidence: [{ kind: "docs", ref: "docs/required.md" }] }, f.options)).ready, false);
  await f.client.docs(f.item, { add: ["path=docs/required.md"] });
  assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item, actor: "fixture", requiredEvidence: [{ kind: "docs", ref: "docs/required.md" }] }, f.options)).ready, true);
  t.diagnostic(JSON.stringify({ nativeSeverityCases: cases, modes: 2, effects: 4, stages: 3, ruleKinds: 5 }));
});

test("warning-only transitions and close diagnostics stay visible without becoming required inputs", async t => {
  const f = await fixture(t);
  for (const mode of ["off", "warn", "strict"] as const) for (const command of ["start-task", "close"]) {
    await f.client.config("project", "set", "governance_workflow_enforcement", "off");
    const id = await f.create(`Transition ${mode} ${command}`, { resolution: "Resolved", expectedResult: "Expected", actualResult: "Observed" });
    const settings = await readSettings(f.pmRoot);
    await writeSettings(f.pmRoot, { ...settings, schema: { ...settings.schema, type_workflows: [{ type: "Task", allowed_transitions: [] }] } });
    await f.client.config("project", "set", "governance_workflow_enforcement", mode);
    const request: ActionPrerequisiteRequest = { command, item: id, actor: "fixture", ...(command === "close" ? { input: { reason: "Reviewed" } } : {}) };
    const preview = await buildActionPrerequisiteBrief(request, f.options);
    const blocked = command === "start-task" && mode === "strict";
    assert.equal(preview.ready, !blocked, JSON.stringify(preview));
    if (mode === "warn" && command === "start-task") assert.ok(preview.checklist.some(row => row.key === "transition" && row.effect === "warn" && row.blocking === false));
    if (blocked) await assert.rejects(f.client.startTask(id), /transition/i);
    else if (command === "close") await f.client.close(id, "Reviewed");
    else await f.client.startTask(id);
  }
  await f.client.config("project", "set", "governance_workflow_enforcement", "off");
  for (const mode of ["off", "warn", "strict"] as const) {
    await f.client.config("project", "set", "governance_close_validation_default", mode);
    assert.equal((await readSettings(f.pmRoot)).governance.close_validation_default, mode);
    const id = await f.create(`Close evidence severity ${mode}`);
    const child = await f.create("Unfinished direct child", { parent: id });
    await f.client.workflowPolicy("policy-put", "overlapping-advice", { definition: { id: "overlapping-advice", effect: "advise", subject: { operations: ["close"] }, rule: { kind: "require_fields", fields: ["actual_result"] } } });
    const preview = await buildActionPrerequisiteBrief({ command: "close", item: id, input: { reason: "Reviewed" } }, f.options);
    assert.equal(preview.ready, mode !== "strict", JSON.stringify(preview));
    assert.ok(preview.checklist.some(row => row.key === "actual_result" && row.state === "missing"));
    assert.equal(preview.checklist.find(row => row.key === child)?.blocking === false, mode !== "strict");
    assert.equal(preview.checklist.find(row => row.key === "actual_result")?.blocking === false, mode !== "strict");
    if (mode === "strict") await assert.rejects(f.client.close(id, "Reviewed"), /missing|child/i);
    else await f.client.close(id, "Reviewed");
  }
  await f.client.config("project", "set", "governance_close_validation_default", "off");
  await f.client.workflowPolicy("policy-mode", "refuse");
  await f.client.workflowPolicy("policy-put", "overlapping-required", { definition: { id: "overlapping-required", effect: "refuse", subject: { operations: ["close"] }, rule: { kind: "require_fields", fields: ["actual_result"] } } });
  const id = await f.create("Required workspace evidence upgrades advisory completeness");
  const required = await buildActionPrerequisiteBrief({ command: "close", item: id, input: { reason: "Reviewed" } }, f.options);
  assert.equal(required.ready, false);
  assert.ok(required.checklist.some(row => row.key === "actual_result" && row.blocking !== false && row.effect === "refuse"));
  await assert.rejects(f.client.close(id, "Reviewed"), /policy/i);
});

test("composed start admission checks every SDK type command option policy before claiming", { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const options = [...new Set(["description", ...COMMON_MUTATION_COMMAND_OPTION_KEYS, "title", "body", "status", "priority", "type", "tags", "author", "message", "closeReason", "dep", "comment", "note", "file", "doc", "test"].map(key => canonicalizeCommandOptionKey("update", key)).filter((key): key is string => key !== undefined))];
  for (const option of options) {
    await updatePolicies(f.pmRoot, []);
    const id = await f.create(`Required native option ${option}`, { description: "Already recorded, not a supplied option", body: "Already recorded", actualResult: "Observed" });
    await updatePolicies(f.pmRoot, [{ command: "update", option, required: true }]);
    const settings = await readSettings(f.pmRoot);
    const policy = resolveCommandOptionPolicyState(resolveTypeDefinition("Task", resolveItemTypeRegistry(settings))!, "update", []);
    assert.deepEqual(policy.required, [option]);
    const before = await snapshot(f.pmRoot);
    const preview = await buildActionPrerequisiteBrief({ command: "start-task", item: id, actor: "fixture" }, f.options);
    const provided = option === "status" || option === "author";
    assert.equal(preview.ready, provided, option);
    assert.ok(preview.checklist.some(row => row.key === `option:${option}` && row.state === (provided ? "satisfied" : "missing")), option);
    assert.deepEqual(await snapshot(f.pmRoot), before);
    if (provided) await f.client.startTask(id, { author: "fixture" });
    else {
      await assert.rejects(f.client.startTask(id, { author: "fixture" }), /required option/i);
      assert.equal((await f.client.get(id, { full: true })).item.assignee, "fixture", "native composed failure occurs after its claim");
    }
    // Close is not an update composition and must not inherit this option policy.
    assert.equal((await buildActionPrerequisiteBrief({ command: "close", item: id, actor: "fixture", input: { reason: "Reviewed", resolution: "Resolved", expectedResult: "Expected", actualResult: "Observed" } }, f.options)).ready, true, option);
  }
  for (const [option, extra, expected] of [["status", { enabled: false }, false], ["description", { enabled: false }, true], ["status", { visible: false }, true], ["status", { required: true, enabled: false }, false]] as const) {
    await updatePolicies(f.pmRoot, [{ command: "update", option, ...extra }]);
    assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item, actor: "fixture" }, f.options)).ready, expected);
  }
  await updatePolicies(f.pmRoot, [{ command: "update", option: "author", required: true }]);
  assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options)).ready, false);
  await updatePolicies(f.pmRoot, [{ command: "update", option: "author", enabled: false }]);
  assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options)).ready, false);
  assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item, actor: "fixture" }, f.options)).ready, false);
  await updatePolicies(f.pmRoot, [{ command: "create", option: "description", required: true }]);
  assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options)).ready, true);
  t.diagnostic(JSON.stringify({ nativeUpdateOptionKeys: options.length, policyStates: "required,disabled,hidden,contradictory,create-only" }));
});

test("retained ownership metadata never denies either action without a live assignee", async t => {
  const f = await fixture(t);
  for (const mode of ["none", "warn", "strict"]) for (const actor of ["new-agent-a", "new-agent-b"]) {
    await f.client.config("project", "set", "governance_ownership_enforcement", mode);
    const id = await f.create(`Recurred work ${mode} ${actor}`, { resolution: "Resolved", expectedResult: "Expected", actualResult: "Observed" });
    await f.client.claim(id, { author: "prior-agent" });
    await f.client.close(id, "Previously completed", { author: "prior-agent" });
    await f.client.reopen(id, "Newly recurring work", { author: actor });
    const item = (await f.client.get(id, { full: true })).item;
    assert.equal(item.assignee, undefined); assert.equal(item.claim_principal, "prior-agent");
    const before = await snapshot(f.pmRoot);
    for (const command of ["start-task", "close"]) {
      const result = await buildActionPrerequisiteBrief({ command, item: id, actor, ...(command === "close" ? { input: { reason: "Reverified", resolution: "Resolved again", expectedResult: "Expected", actualResult: "Observed" } } : {}) }, f.options);
      assert.equal(result.ready, true, JSON.stringify(result));
      assert.ok(!result.checklist.some(row => row.key === "ownership"));
    }
    assert.deepEqual(await snapshot(f.pmRoot), before);
    await f.client.startTask(id, { author: actor });
    assert.equal((await f.client.get(id, { full: true })).item.assignee, actor);
    await f.client.close(id, "Reverified", { author: actor, resolution: "Resolved again", expectedResult: "Expected", actualResult: "Observed" });
  }
  const legacy = await f.create("Previously persisted assignee without principal", { assignee: "prior-agent", resolution: "Resolved", expectedResult: "Expected", actualResult: "Observed" });
  assert.equal((await f.client.get(legacy, { full: true })).item.claim_principal, undefined);
  for (const command of ["start-task", "close"]) {
    const input = command === "close" ? { input: { reason: "Reviewed" } } : {};
    const denied = await buildActionPrerequisiteBrief({ command, item: legacy, actor: "different-agent", ...input }, f.options);
    assert.ok(denied.checklist.some(row => row.key === "ownership" && row.ref === `${legacy}#/assignee`));
    const undeclared = await buildActionPrerequisiteBrief({ command, item: legacy, ...input }, f.options);
    assert.ok(undeclared.checklist.some(row => row.key === "actor" && row.state === "missing"));
    assert.equal((await buildActionPrerequisiteBrief({ command, item: legacy, actor: "prior-agent", ...input }, f.options)).ready, true);
  }
  await assert.rejects(f.client.startTask(legacy, { author: "different-agent" }), /assign|claim|owner/i);
  await assert.rejects(f.client.close(legacy, "Reviewed", { author: "different-agent" }), /assign|claim|owner/i);
});

test("explicit start admission matches native execution across dispatch types and status roles", async t => {
  const f = await fixture(t);
  let seed = 0x1892026;
  const random = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  const statuses = ["open", "blocked"];
  for (const role of ["active", "draft", "blocked"] as const) {
    const status = `custom-${random(100000)}-${role}`;
    await f.client.schemaAddStatus(status, { role: [role] }); statuses.push(status);
  }
  for (const type of ["Decision", "Milestone", "Task"]) for (const status of statuses) {
    const id = await f.create(`Explicit ${type} ${status}`, { type, status });
    await f.create("Unfinished direct child", { parent: id });
    const before = await snapshot(f.pmRoot);
    const preview = await buildActionPrerequisiteBrief({ command: "start-task", item: id, actor: "fixture" }, f.options);
    assert.equal(preview.ready, true, JSON.stringify(preview));
    assert.deepEqual(await snapshot(f.pmRoot), before);
    const native = await f.client.startTask(id, { author: "fixture" });
    assert.equal(native.update.item.status, "in_progress");
  }
});

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
  await f.client.workflowPolicy("policy-remove", "extra-close");
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
  const classify = async (id: string) => {
    const items = (await f.client.listAllComplete({ includeBody: true })).items;
    return computeActionabilityReport(items.filter(row => row.id === id), items, resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema), resolveItemTypeRegistry(await readSettings(f.pmRoot)));
  };
  assert.ok((await classify(f.item)).containers.some(row => row.item.id === f.item));
  assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options)).ready, true);
  result = await buildActionPrerequisiteBrief({ command: "close", item: f.item }, f.options);
  assert.ok(result.checklist.some(row => row.kind === "prerequisite" && row.key === child));
  await f.client.update(child, { status: "custom-canceled", closeReason: "Canceled", parent: f.item, sprint: "none", release: "none" });
  assert.ok(!(await buildActionPrerequisiteBrief({ command: "close", item: f.item }, f.options)).checklist.some(row => row.key === child));
  await f.client.update(f.item, { status: "blocked", blockedReason: "Pending review", parent: "none", sprint: "none", release: "none" });
  assert.ok(resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema).blocked_statuses.has((await f.client.get(f.item, { full: true })).item.status!));
  assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: f.item }, f.options)).ready, true);
  for (const type of ["Decision", "Milestone"]) {
    const id = await f.create(`Review ${type}`, { type });
    const report = await classify(id);
    assert.ok((type === "Decision" ? report.decisions : report.gates).some(row => row.item.id === id));
    assert.equal((await buildActionPrerequisiteBrief({ command: "start-task", item: id, actor: "fixture" }, f.options)).ready, true);
    assert.equal((await f.client.startTask(id, { author: "fixture" })).update.item.status, "in_progress");
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
  await f.client.workflowPolicy("policy-mode", "refuse");
  await f.client.workflowPolicy("policy-put", "review", { definition: { id: "review", effect: "refuse", subject: { operations: ["close"] }, rule: { kind: "approval", fields: ["resolution"], authors: ["reviewer"] } } });
  await f.client.workflowPolicy("policy-put", "actor", { definition: { id: "actor", rule: { kind: "authors", authors: ["fixture"] } } });
  await f.client.workflowPolicy("policy-put", "create-only", { definition: { id: "create-only", subject: { operations: ["create"] }, rule: { kind: "require_fields", fields: ["body"] } } });
  const result = await buildActionPrerequisiteBrief({ command: "close", item: f.item }, f.options);
  assert.ok(result.refusals.some(row => row.capability === "policy:review")); assert.ok(result.checklist.some(row => row.key === "actor"));
  const allowedActor = await buildActionPrerequisiteBrief({ command: "close", item: f.item, actor: " fixture " }, f.options);
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

test("native automatic metadata and composed claim policies cannot be certified from a partial proposed record", async t => {
  const f = await fixture(t);
  await f.client.update(f.item, { actualResult: "Observed", parent: "none", sprint: "none", release: "none" });
  await f.client.claim(f.item, { author: "fixture" });
  await f.client.workflowPolicy("policy-mode", "refuse");
  for (const rule of [{ kind: "field_writers", fields: ["assignee"], authors: ["reviewer"] }, { kind: "require_fields", fields: ["assignee"] }]) {
    await f.client.workflowPolicy("policy-put", "ownership", { definition: { id: "ownership", effect: "refuse", subject: { operations: ["close"] }, rule } });
    const preview = await buildActionPrerequisiteBrief({ command: "close", item: f.item, actor: "fixture", input: { reason: "Reviewed" } }, f.options);
    assert.equal(preview.ready, false);
    assert.ok(preview.refusals.some(row => row.capability === "policy:ownership"));
    // Core closes clear assignment: its policy decision must remain authoritative.
    await assert.rejects(f.client.close(f.item, "Reviewed", { author: "fixture" }), error => error instanceof Error && /policy/i.test(error.message));
    await f.client.workflowPolicy("policy-remove", "ownership");
  }
  await f.client.workflowPolicy("policy-put", "claim-actor", { definition: { id: "claim-actor", effect: "refuse", subject: { operations: ["claim"] }, rule: { kind: "authors", authors: ["reviewer"] } } });
  const unclaimed = await f.create("Unclaimed work governed by a claim policy");
  const start = await buildActionPrerequisiteBrief({ command: "start-task", item: unclaimed, actor: "fixture" }, f.options);
  assert.equal(start.ready, false);
  assert.ok(start.refusals.some(row => row.capability === "policy:claim:claim-actor"));
  await assert.rejects(f.client.startTask(unclaimed, { author: "fixture" }), error => error instanceof Error && /policy/i.test(error.message));
  await f.client.workflowPolicy("policy-remove", "claim-actor");
  const owned = await f.create("Strictly owned close target", { resolution: "Resolved", expectedResult: "Expected", actualResult: "Observed" });
  await f.client.claim(owned, { author: "peer" });
  await f.client.config("project", "set", "governance_ownership_enforcement", "strict");
  const close = await buildActionPrerequisiteBrief({ command: "close", item: owned, actor: "fixture", input: { reason: "Reviewed" } }, f.options);
  assert.equal(close.ready, false);
  assert.ok(close.checklist.some(row => row.key === "ownership"));
  await assert.rejects(f.client.close(owned, "Reviewed", { author: "fixture" }), error => error instanceof Error && /owner|assignee|claim|assign/i.test(error.message));
  const unknown = await buildActionPrerequisiteBrief({ command: "close", item: owned, input: { reason: "Reviewed" } }, f.options);
  assert.ok(unknown.checklist.some(row => row.key === "actor" && row.state === "missing"));
  assert.equal((await buildActionPrerequisiteBrief({ command: "close", item: owned, actor: " peer ", input: { reason: "Reviewed" } }, f.options)).ready, true);
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
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: { kind: "docs", ref: "docs/inherited.md" } }));
  Object.assign(inherited, { noise: true });
  invalid.push({ ...valid, requiredEvidence: inherited });
  const iterator = [null];
  Object.defineProperty(iterator, Symbol.iterator, { value: function* () { yield { kind: "docs", ref: "docs/invented.md" }; } });
  invalid.push({ ...valid, requiredEvidence: iterator });
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); invalid.push(revoked.proxy);
  invalid.push({ ...valid, requiredEvidence: new Proxy([], {}) });
  invalid.push(Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`unknown-${index}`, true])));
  for (const input of invalid) {
    assert.throws(() => parseActionPrerequisiteRequest(input), refusal("invalid"));
    await assert.rejects(buildActionPrerequisiteBrief(input as ActionPrerequisiteRequest, { pmRoot: "unreadable-before-validation" }), refusal("invalid"));
  }
  const parsed = parseActionPrerequisiteRequest({ ...valid, input: { reason: " \r\n " }, requiredEvidence: [] });
  assert.equal(parsed.tokenBudget, 4000); assert.deepEqual(parseActionPrerequisiteRequest(parsed), parsed);
  let getterRan = false;
  assert.throws(() => parseActionPrerequisiteRequest({ ...valid, get actor() { getterRan = true; return "fixture"; } }), refusal("invalid"));
  assert.equal(getterRan, false, "untrusted input accessors never execute during validation");
  const arrayAccessor = new Array(1);
  Object.defineProperty(arrayAccessor, 0, { enumerable: true, get() { getterRan = true; return { kind: "docs", ref: "docs/accessor.md" }; } });
  assert.throws(() => parseActionPrerequisiteRequest({ ...valid, requiredEvidence: arrayAccessor }), refusal("invalid"));
  assert.equal(getterRan, false);
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
  for (const type of ["Decision", "Milestone", "Task"]) {
    const id = await f.create(`Native CLI admission ${type}`, { type, resolution: "Resolved", expectedResult: "Expected", actualResult: "Observed" });
    if (type === "Task") {
      await f.client.claim(id, { author: "prior-agent" });
      await f.client.close(id, "Previously completed", { author: "prior-agent" });
      await f.client.reopen(id, "Recurred work", { author: "fixture" });
    }
    await f.client.config("project", "set", "governance_ownership_enforcement", "strict");
    const prior = await snapshot(f.pmRoot);
    for (const command of (type === "Task" ? ["start-task", "close"] : ["start-task"])) for (const format of ["json", "toon"]) {
      const request = { actor: "fixture", ...(command === "close" ? { input: { reason: "Reviewed", resolution: "Resolved", expectedResult: "Expected", actualResult: "Observed" } } : {}) };
      const output = run([...(format === "json" ? ["--json"] : []), "brief", "action", command, id, "--request", JSON.stringify(request)]);
      assert.equal(output.status, 0, output.stdout + output.stderr);
      assert.equal(output.stderr, "");
      if (format === "json") assert.equal((JSON.parse(output.stdout) as ActionPrerequisiteBrief).ready, true, output.stdout);
      else assert.match(output.stdout, /ready: true/);
    }
    assert.deepEqual(await snapshot(f.pmRoot), prior);
    assert.equal(run(["--author", "fixture", "start-task", id]).status, 0);
  }
  await updatePolicies(f.pmRoot, [{ command: "update", option: "description", required: true }]);
  const prior = await snapshot(f.pmRoot);
  for (const format of ["json", "toon"]) {
    const output = run([...(format === "json" ? ["--json"] : []), "brief", "action", "start-task", f.item, "--request", '{"actor":"fixture"}']);
    assert.equal(output.status, 0, output.stdout + output.stderr); assert.equal(output.stderr, "");
    assert.match(output.stdout, /option:description/);
    if (format === "json") assert.equal((JSON.parse(output.stdout) as ActionPrerequisiteBrief).ready, false);
    else assert.match(output.stdout, /ready: false/);
  }
  const injected = await harness.runCommand({ command: "brief action", args: ["start-task", f.item], pmRoot: f.pmRoot, options: { request: '{"actor":"fixture"}' } });
  assert.equal((injected.result as ActionPrerequisiteBrief).ready, false);
  assert.deepEqual(await snapshot(f.pmRoot), prior);
  await updatePolicies(f.pmRoot, []);
  await f.client.workflowPolicy("policy-mode", "refuse");
  await f.client.workflowPolicy("policy-put", "advisory-actor", { definition: { id: "advisory-actor", effect: "advise", subject: { operations: ["claim", "update", "close"] }, rule: { kind: "authors", authors: ["reviewer"] } } });
  const settings = await readSettings(f.pmRoot);
  await writeSettings(f.pmRoot, { ...settings, schema: { ...settings.schema, type_workflows: [{ type: "Task", allowed_transitions: [] }] } });
  await f.client.config("project", "set", "governance_workflow_enforcement", "warn");
  const advisoryBefore = await snapshot(f.pmRoot);
  for (const command of ["start-task", "close"]) for (const format of ["json", "toon"]) {
    const request = { actor: "fixture", ...(command === "close" ? { input: { reason: "Reviewed" } } : {}) };
    const output = run([...(format === "json" ? ["--json"] : []), "brief", "action", command, f.item, "--request", JSON.stringify(request)]);
    assert.equal(output.status, 0, output.stdout + output.stderr); assert.equal(output.stderr, "");
    if (format === "json") {
      const parsed = JSON.parse(output.stdout) as ActionPrerequisiteBrief;
      assert.equal(parsed.ready, true, output.stdout);
      assert.ok(parsed.checklist.some(row => row.blocking === false && row.effect === "advise"));
    } else assert.match(output.stdout, /ready: true/);
  }
  const advisoryInjected = await harness.runCommand({ command: "brief action", args: ["start-task", f.item], pmRoot: f.pmRoot, options: { request: '{"actor":"fixture"}' } });
  assert.equal((advisoryInjected.result as ActionPrerequisiteBrief).ready, true);
  assert.deepEqual(await snapshot(f.pmRoot), advisoryBefore);
  assert.equal(run(["--author", "fixture", "start-task", f.item]).status, 0);
});
