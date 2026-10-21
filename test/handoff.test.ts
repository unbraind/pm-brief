import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { acquireLock, PmClient } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import extension, { acknowledgeHandoff, createHandoff, inspectHandoff, previewHandoff, parseHandoffContract, parseHandoffResponse, HandoffError } from "../index.ts";
import type { HandoffContract, HandoffOptions, HandoffPacket, HandoffResponse } from "../index.ts";

const root = resolve(import.meta.dirname, "..");
const workspace = await mkdtemp(join(tmpdir(), "brief-contract-"));
const pmRoot = join(workspace, ".agents", "pm");
const cli = resolve(root, "node_modules/@unbrained/pm-cli/dist/cli.js");
const options: HandoffOptions = { pmRoot, author: "sender", tokenBudget: 16000 };
const client = new PmClient({ pmRoot, author: "fixture", noExtensions: true });
let focus = ""; let blocker = ""; let contract: HandoffContract;

/** Produce explicit answers to all contract obligations, including acknowledged evidence gaps. */
function response(packet: HandoffPacket): HandoffResponse {
  return { digest: packet.digest, questions: Object.fromEntries(packet.contract.questions.map(row => [row.id, "Use the public fixture"])), assumptions: Object.fromEntries(packet.contract.assumptions.map(row => [row.id, "Unresolved; verify before execution"])), evidence: Object.fromEntries(packet.contract.requiredEvidence.map(row => [row.id, "Checked linkage; missing artifacts remain a blocker"])) };
}
/** Match machine-readable SDK errors and require every refusal to carry a usable remedy. */
function refusal(code: string) {
  return (error: unknown): boolean => { assert.ok(error instanceof HandoffError); assert.equal(error.code, code); assert.ok(error.remedy.length > 10); return true; };
}
/** Run the real installed CLI in a directory whose PATH cannot resolve git. */
function run(args: string[], author = "receiver-a") {
  return spawnSync(process.execPath, [cli, "--pm-path", pmRoot, ...args], { cwd: workspace, env: { ...process.env, PM_AUTHOR: author, PATH: join(workspace, "bin"), GIT_CEILING_DIRECTORIES: dirname(workspace), HOME: join(workspace, "home") }, encoding: "utf8", timeout: 180000 });
}
/** Launch independent receiver processes against the same tracker, without serializing their writes. */
function concurrentAck(id: string, input: string, author: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--pm-path", pmRoot, "--json", "brief", "handoff", "ack", id, "--input", input, "--token-budget", "16000"], { cwd: workspace, env: { ...process.env, PM_AUTHOR: author, PATH: join(workspace, "bin"), GIT_CEILING_DIRECTORIES: dirname(workspace), HOME: join(workspace, "home") } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject); child.on("close", code => { if (code === 0) resolve(stdout); else reject(new Error(stderr || stdout)); });
  });
}

before(async () => {
  await mkdir(join(workspace, "bin")); await mkdir(join(workspace, "home")); await symlink(process.execPath, join(workspace, "bin", "node"));
  await client.init("handoff", { defaults: true, agentGuidance: "skip", mergeFence: false });
  blocker = (await client.create({ title: "External review gate", type: "Task" })).item.id;
  focus = (await client.create({ title: "Implement the agreed contract", type: "Task", blockedBy: blocker })).item.id;
  contract = { focus: [focus], questions: [{ id: "q1", text: "Which fixture can be used?" }], assumptions: [{ id: "a1", text: "Review remains unresolved" }], requiredEvidence: [{ id: "e1", item: focus, kind: "docs", ref: "docs/proof.md" }] };
  const extensionRoot = join(pmRoot, "extensions", "pm-brief"); await mkdir(extensionRoot, { recursive: true });
  await writeFile(join(extensionRoot, "manifest.json"), await readFile(join(root, "manifest.json")));
  await writeFile(join(extensionRoot, "package.json"), await readFile(join(root, "package.json")));
  await cp(join(root, "dist"), join(extensionRoot, "dist"), { recursive: true }); await symlink(join(root, "node_modules"), join(extensionRoot, "node_modules"));
});
after(() => rm(workspace, { recursive: true, force: true }));

test("contract preview is read-only and revisions include full source rows and blockers", async () => {
  const count = (await client.listAllComplete()).items.length;
  const packet = await previewHandoff(contract, options);
  assert.equal(packet.id, "preview"); assert.equal((await client.listAllComplete()).items.length, count);
  assert.deepEqual(packet.missingEvidence, ["e1"]);
  assert.equal(packet.contract.items.length, 2);
  assert.deepEqual(packet.contract.items.find(row => row.id === focus)?.blockers, [blocker]);
  assert.match(packet.contract.items[0].revision!, /^[a-f0-9]{64}$/);
  assert.ok(packet.estimatedTokenCeiling < 4000);
});

test("independent receivers, idempotent retries, missing evidence and changed blocker validity", async () => {
  const packet = await createHandoff(contract, options); const answers = response(packet);
  await Promise.all([acknowledgeHandoff(packet.id, answers, { ...options, author: "receiver-a" }), acknowledgeHandoff(packet.id, answers, { ...options, author: "receiver-b" })]);
  const prior = await inspectHandoff(packet.id, options, "receiver-a");
  await acknowledgeHandoff(packet.id, answers, { ...options, author: "receiver-a", tokenBudget: prior.estimatedTokenCeiling });
  const status = await inspectHandoff(packet.id, options);
  assert.deepEqual(status.receipts.map(row => row.receiver).sort(), ["receiver-a", "receiver-b"]);
  assert.ok(status.receipts.every(row => row.valid && !row.ready && row.missingEvidence[0] === "e1"));
  assert.equal((await inspectHandoff(packet.id, options, "receiver-b")).receipts.length, 1);
  await client.update(blocker, { body: "Review now requires an additional public evidence report" });
  const stale = await inspectHandoff(packet.id, options);
  assert.deepEqual(stale.staleItems, [blocker]); assert.ok(stale.receipts.every(row => !row.valid && !row.ready));
  await assert.rejects(acknowledgeHandoff(packet.id, answers, { ...options, author: "receiver-c" }), refusal("stale"));
  assert.equal((await inspectHandoff(packet.id, options)).receipts.length, 2);
});

test("native linked evidence remains distinct from validation of artifact contents", async () => {
  await client.docs(focus, { add: ["path=docs/proof.md"] });
  await client.files(focus, { add: ["path=source.ts"] });
  await client.run("test", { id: focus, options: { add: ["command=node --version"] } });
  const input: HandoffContract = { ...contract, requiredEvidence: [...contract.requiredEvidence, { id: "file", item: focus, kind: "files", ref: "source.ts" }, { id: "test", item: focus, kind: "tests", ref: "node --version" }, { id: "absent", item: "handoff-missing", kind: "docs", ref: "missing.md" }] };
  const packet = await createHandoff(input, options);
  assert.deepEqual(packet.missingEvidence, ["absent"]);
  assert.equal(packet.contract.items.find(row => row.id === "handoff-missing")?.revision, null);
  const complete = await createHandoff({ ...input, requiredEvidence: input.requiredEvidence.slice(0, -1) }, options);
  assert.equal((await acknowledgeHandoff(complete.id, response(complete), { ...options, author: "ready-agent" })).receipts[0].ready, true);
  await client.docs(focus, { remove: ["path=docs/proof.md"] });
  const status = await inspectHandoff(complete.id, options);
  assert.deepEqual(status.packet.missingEvidence, ["e1"]); assert.equal(status.receipts[0].valid, false);
});

test("transitive cycles, inverse blocks and absent blocker targets are retained", async () => {
  const a = (await client.create({ title: "Cyclic gate one", type: "Task" })).item.id;
  const b = (await client.create({ title: "Cyclic gate two", type: "Task", blockedBy: a })).item.id;
  await client.update(a, { blockedBy: b, dep: ["id=handoff-absent,kind=blocked_by"], allowUnresolvedDeps: true });
  const c = (await client.create({ title: "Gate declared from its blocking side", type: "Task", dep: [`id=${a},kind=blocks`] })).item.id;
  const packet = await createHandoff({ focus: [a], questions: [], assumptions: [], requiredEvidence: [] }, options);
  assert.deepEqual(new Set(packet.contract.items.map(row => row.id)), new Set([a, b, c, "handoff-absent"]));
  await client.update(c, { title: "Inverse blocker changed" });
  assert.deepEqual((await inspectHandoff(packet.id, options)).staleItems, [c]);
});

test("invalid JSON contracts, identity, missing items and all response obligations refuse before writing", async () => {
  for (const value of [null, [], 1, {}, { ...contract, focus: [] }, { ...contract, focus: [focus, focus] }, { ...contract, focus: ["../bad"] }, { ...contract, questions: [{ id: "q", text: " " }] }, { ...contract, assumptions: [{ id: "x", text: "a" }, { id: "x", text: "b" }] }, { ...contract, requiredEvidence: [{ id: "e", item: focus, kind: "unknown", ref: "a" }] }, { ...contract, questions: new Array(33).fill({ id: "q", text: "a" }) }, { ...contract, questions: [{ id: "q", text: "x".repeat(2001) }] }]) assert.throws(() => parseHandoffContract(value), refusal("invalid"));
  for (const value of [null, {}, { digest: "bad", questions: {}, assumptions: {}, evidence: {} }, { digest: "a".repeat(64), questions: { bad: "" }, assumptions: {}, evidence: {} }, { digest: "a".repeat(64), questions: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, "a"])), assumptions: {}, evidence: {} }]) assert.throws(() => parseHandoffResponse(value), refusal("invalid"));
  const saved = process.env.PM_AUTHOR; delete process.env.PM_AUTHOR;
  try { await assert.rejects(createHandoff(contract, { pmRoot }), refusal("identity")); }
  finally { if (saved !== undefined) process.env.PM_AUTHOR = saved; }
  await assert.rejects(createHandoff({ ...contract, focus: ["handoff-missing"] }, options), refusal("missing"));
  await assert.rejects(inspectHandoff("handoff-missing", options), refusal("missing"));
  const packet = await createHandoff(contract, options); const answers = response(packet);
  await assert.rejects(acknowledgeHandoff(packet.id, { ...answers, digest: "b".repeat(64) }, options), refusal("stale"));
  const wrongs: HandoffResponse[] = [{ ...answers, questions: {} }, { ...answers, assumptions: {} }, { ...answers, evidence: {} }, { ...answers, questions: { extra: "answer" } }];
  for (const wrong of wrongs) await assert.rejects(acknowledgeHandoff(packet.id, wrong, options), refusal("responses"));
  assert.equal((await inspectHandoff(packet.id, options)).receipts.length, 0);
});

test("budget refusals preserve tracker and omit no obligations", async () => {
  const before = (await client.listAllComplete()).items.length;
  await assert.rejects(createHandoff(contract, { ...options, tokenBudget: 1 }), refusal("budget"));
  for (const tokenBudget of [0, 1.5, 64001, Number.NaN]) await assert.rejects(previewHandoff(contract, { ...options, tokenBudget }), refusal("invalid"));
  assert.equal((await client.listAllComplete()).items.length, before);
  const packet = await createHandoff(contract, { pmRoot, author: "sender" });
  const budget = (await inspectHandoff(packet.id, options)).estimatedTokenCeiling;
  await assert.rejects(acknowledgeHandoff(packet.id, response(packet), { ...options, tokenBudget: budget + 1 }), refusal("budget"));
  assert.equal((await inspectHandoff(packet.id, options)).receipts.length, 0);
});

test("malformed tracker artifacts and comments fail closed", async () => {
  const packet = await createHandoff(contract, options);
  await client.comments(packet.id, { add: "Ordinary discussion is not a receipt" });
  assert.equal((await inspectHandoff(packet.id, options)).receipts.length, 0);
  await assert.rejects(inspectHandoff(focus, options), refusal("integrity"));
  await client.comments(packet.id, { add: 'pm-brief.ack/v1 {"broken":true}' });
  await assert.rejects(inspectHandoff(packet.id, options), refusal("integrity"));
  const altered = await createHandoff(contract, options);
  await client.update(altered.id, { body: "corrupt" });
  await assert.rejects(inspectHandoff(altered.id, options), refusal("integrity"));
  const wrong = await createHandoff(contract, options);
  await client.comments(wrong.id, { add: "pm-brief.ack/v1 " + JSON.stringify({ receiver: "imposter", response: response(wrong) }), author: "someone-else" });
  await assert.rejects(inspectHandoff(wrong.id, options, "other"), refusal("integrity"));
  await assert.rejects(previewHandoff(contract, { pmRoot: join(workspace, "uninitialized"), author: "sender" }), refusal("tracker"));
});

test("real CLI create, preview, concurrent ack and show work without git in native TOON and JSON", async () => {
  const input = join(workspace, "contract.json"); await writeFile(input, JSON.stringify(contract));
  const preview = run(["--json", "brief", "handoff", "preview", "--input", input]); assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  const created = run(["--json", "brief", "handoff", "create", "--input", input]); assert.equal(created.status, 0, created.stderr || created.stdout);
  const packet = JSON.parse(created.stdout) as HandoffPacket;
  const inputResponse = join(workspace, "response.json"); await writeFile(inputResponse, JSON.stringify(response(packet)));
  await Promise.all([concurrentAck(packet.id, inputResponse, "process-a"), concurrentAck(packet.id, inputResponse, "process-b")]);
  const shown = run(["--json", "brief", "handoff", "show", packet.id]); assert.equal(shown.status, 0, shown.stderr || shown.stdout);
  assert.equal((JSON.parse(shown.stdout) as { receipts: unknown[] }).receipts.length, 2);
  const toon = run(["brief", "handoff", "show", packet.id, "--receiver", "process-b", "--token-budget", "16000"]);
  assert.equal(toon.status, 0, toon.stderr || toon.stdout); assert.match(toon.stdout, /process-b/); assert.doesNotMatch(toon.stdout, /process-a/);
  const invalid = run(["--json", "brief", "handoff", "create", "--input", join(workspace, "absent.json")]); assert.equal(invalid.status, 2); assert.match(invalid.stderr + invalid.stdout, /Remedy/); assert.match(invalid.stderr + invalid.stdout, /handoff_invalid/);
});

test("registered command refusals remain expected errors with remedies", async () => {
  const activation = await activateExtensionForTest(extension, { name: "pm-brief", capabilities: ["commands", "services", "schema"] });
  const input = join(workspace, "command-contract.json"); await writeFile(input, JSON.stringify(contract));
  const invoke = (command: string, args: string[] = [], overrides: Record<string, unknown> = {}) => runRegisteredCommandForTest(activation.commands, { command: `brief handoff ${command}`, pmRoot, args, global: { author: "harness-agent" }, options: { input, tokenBudget: "16000", ...overrides } });
  const preview = await invoke("preview"); assert.equal(preview.handled, true);
  const created = await invoke("create"); const packet = created.result as HandoffPacket;
  await writeFile(input, JSON.stringify(response(packet)));
  assert.equal((await invoke("ack", [packet.id])).handled, true);
  assert.equal((await invoke("show", [packet.id], { receiver: "harness-agent" })).handled, true);
  await writeFile(input, "[]"); await assert.rejects(invoke("create"), /handoff invalid/);
  await assert.rejects(invoke("show"), /handoff invalid/);
  await writeFile(input, "not json"); await assert.rejects(invoke("create"), /Cannot read handoff JSON input/);
  await writeFile(input, "x".repeat(128001)); await assert.rejects(invoke("create"), /Cannot read handoff JSON input/);
  await assert.rejects(invoke("show", [packet.id], { tokenBudget: "1" }), /handoff budget/);
  await client.update(blocker, { body: "A later blocker revision" });
  await writeFile(input, JSON.stringify(response(packet))); await assert.rejects(invoke("ack", [packet.id]), /handoff stale/);
});

/** Re-sign synthetic protocol corruption to exercise structural validation after the digest check. */
function signed(document: unknown): string {
  const canonical = JSON.stringify(document, (_key, value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))) : value);
  return JSON.stringify({ document, digest: createHash("sha256").update(canonical).digest("hex") });
}

test("oversized blocker closures refuse and structurally corrupt signed packets never become receipts", async () => {
  const large = (await client.create({ title: "Too many declared gates", type: "Task", dep: Array.from({ length: 65 }, (_, i) => `id=handoff-unresolved-${i},kind=blocked_by`), allowUnresolvedDeps: true })).item.id;
  await assert.rejects(previewHandoff({ ...contract, focus: [large] }, options), refusal("budget"));
  const packet = await createHandoff(contract, options);
  for (const bad of [
    { ...packet.contract, protocol: "other" },
    { ...packet.contract, items: null },
    { ...packet.contract, items: Array.from({ length: 65 }, () => packet.contract.items[0]) },
    { ...packet.contract, items: [{ ...packet.contract.items[0], revision: 1 }] },
    { ...packet.contract, items: [{ ...packet.contract.items[0], blockers: null }] },
    { ...packet.contract, items: [{ ...packet.contract.items[0], blockers: ["bad/path"] }] },
    { ...packet.contract, items: [{ ...packet.contract.items[0], extra: true }] },
    { ...packet.contract, extra: true },
  ]) {
    await client.update(packet.id, { body: signed(bad) });
    await assert.rejects(inspectHandoff(packet.id, options), refusal("integrity"));
  }
});


test("native write failures are translated to actionable CLI tracker refusals", async () => {
  const otherRoot = join(workspace, "readonly-tracker");
  const native = new PmClient({ pmRoot: otherRoot, author: "fixture", noExtensions: true });
  await native.init("readonly", { defaults: true, agentGuidance: "skip", mergeFence: false });
  const item = (await native.create({ title: "Read-only source", type: "Task" })).item.id;
  const input = join(workspace, "readonly-contract.json");
  await writeFile(input, JSON.stringify({ focus: [item], questions: [], assumptions: [], requiredEvidence: [] }));
  const decisions = join(otherRoot, "decisions");
  await mkdir(decisions, { recursive: true }); await chmod(decisions, 0o555);
  const activation = await activateExtensionForTest(extension, { name: "pm-brief", capabilities: ["commands", "services", "schema"] });
  try {
    await assert.rejects(runRegisteredCommandForTest(activation.commands, { command: "brief handoff create", pmRoot: otherRoot, global: { author: "harness-agent" }, options: { input } }), /handoff tracker: Handoff operation could not complete.*Remedy/);
  } finally { await chmod(decisions, 0o755); }
});


test("changed blockers invalidate saved acknowledgments", async () => {
  const packet = await createHandoff(contract, options);
  await acknowledgeHandoff(packet.id, response(packet), { ...options, author: "single-receiver" });
  await client.update(blocker, { body: "A materially changed prerequisite" });
  const status = await inspectHandoff(packet.id, options);
  assert.deepEqual(status.staleItems, [blocker]);
  assert.equal(status.receipts[0].valid, false);
});

test("exhausted receipt locks give typed remedies and safe idempotent retries", async () => {
  const packet = await createHandoff(contract, options);
  const saved = process.env.PM_LOCK_WAIT_MS; process.env.PM_LOCK_WAIT_MS = "0";
  const unlock = await acquireLock(pmRoot, packet.id, 3600, "fixture-lock-holder", false, true, 0);
  try { await assert.rejects(acknowledgeHandoff(packet.id, response(packet), options), refusal("tracker")); }
  finally { await unlock(); if (saved === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = saved; }
  await acknowledgeHandoff(packet.id, response(packet), options);
  await acknowledgeHandoff(packet.id, response(packet), options);
  assert.equal((await inspectHandoff(packet.id, options)).receipts.length, 1);
});

test("native append failures preserve typed SDK remedies", async () => {
  const otherRoot = join(workspace, "append-refusal-tracker");
  const native = new PmClient({ pmRoot: otherRoot, author: "fixture", noExtensions: true });
  await native.init("append", { defaults: true, agentGuidance: "skip", mergeFence: false });
  const id = (await native.create({ title: "Append refusal source", type: "Task" })).item.id;
  const otherOptions = { pmRoot: otherRoot, author: "receiver" };
  const packet = await createHandoff({ focus: [id], questions: [], assumptions: [], requiredEvidence: [] }, otherOptions);
  const decisions = join(otherRoot, "decisions"); await chmod(decisions, 0o555);
  try {
    await assert.rejects(acknowledgeHandoff(packet.id, response(packet), otherOptions), (error: unknown) => {
      assert.ok(error instanceof HandoffError); assert.equal(error.code, "tracker"); assert.match(error.message, /receipt could not be appended/); assert.match(error.remedy, /Retry the same/); return true;
    });
  } finally { await chmod(decisions, 0o755); }
});


test("native source titles longer than obligation limits round-trip through stored packets", async () => {
  const title = "Synthetic native title " + "x".repeat(2100);
  const id = (await client.create({ type: "Task", title })).item.id;
  const packet = await createHandoff({ focus: [id], questions: [], assumptions: [], requiredEvidence: [] }, options);
  assert.equal(packet.contract.items[0].title, title);
  assert.equal((await inspectHandoff(packet.id, options)).packet.contract.items[0].title, title);
  const result = await acknowledgeHandoff(packet.id, response(packet), options);
  assert.equal(result.receipts[0].valid, true);
});


test("native identifiers and blocker references round-trip without obligation key caps", async () => {
  const missing = "external-" + "x".repeat(150);
  const id = (await client.create({ type: "Task", title: "Long native identity and missing blocker", id: "x".repeat(150), dep: [`id=${missing},kind=blocked_by`], allowUnresolvedDeps: true })).item.id;
  assert.ok(id.length > 128);
  const packet = await createHandoff({ focus: [id], questions: [], assumptions: [], requiredEvidence: [{ id: "report", item: id, kind: "docs", ref: "docs/report.md" }] }, options);
  assert.ok(packet.contract.items.some(row => row.id.length > 128 && row.revision === null));
  const status = await inspectHandoff(packet.id, options);
  assert.deepEqual(status.packet.contract.focus, [id]);
  const result = await acknowledgeHandoff(packet.id, response(packet), options);
  assert.equal(result.receipts[0].valid, true); assert.deepEqual(result.receipts[0].missingEvidence, ["report"]);
});
