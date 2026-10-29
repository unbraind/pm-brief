import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { PmClient, getHistoryPath, estimatePmOutputTokens, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildDecisionFollowThroughBrief, readFollowThroughObservation, parseFollowThroughDeclaration, parseFollowThroughRequest, validateFollowThroughAccounting, FollowThroughError } from "../index.ts";
import type { DecisionFollowThroughBrief, FollowThroughDeclaration, FollowThroughOutcome, FollowThroughRequest } from "../index.ts";

const root = resolve(import.meta.dirname, "..");
/** Typed failures retain concrete remedies and never become empty successful briefs. */
function refusal(code: string) {
  return (error: unknown): boolean => { assert.ok(error instanceof FollowThroughError); assert.equal(error.code, code); assert.ok(error.remedy.length > 20); return true; };
}
/** A native no-git tracker; all mutations explicitly declare relationship and scope fields. */
async function fixture(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "brief-follow-through-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const pmRoot = join(workspace, ".agents/pm"); const client = new PmClient({ pmRoot, noExtensions: true, author: "fixture" });
  await client.init("follow", { defaults: true, agentGuidance: "skip", mergeFence: false });
  await client.schemaAddField("brief_follow_through", { type: "object" });
  const scope = { parent: "none", sprint: "none", release: "none", clearDeps: true };
  const create = async (title: string, extra: Parameters<PmClient["create"]>[0] = {}) => (await client.create({ title, type: "Task", ...scope, ...extra })).item.id;
  const update = (id: string, extra: Parameters<PmClient["update"]>[1]) => client.update(id, { ...scope, clearDeps: extra?.dep ? undefined : true, ...extra });
  const options = { pmRoot, client };
  const decision = await create("Adopt the measured approach", { type: "Decision" });
  const observed = await create("Recorded latency measurement", { actualResult: "Latency fell.\r\nSecond measurement. 測定😀" });
  const contradicted = await create("Recorded resource measurement", { actualResult: "Resource use increased" });
  const action = await create("Run remaining experiment");
  const positive = await readFollowThroughObservation(observed, options); const negative = await readFollowThroughObservation(contradicted, options);
  const outcomes: FollowThroughOutcome[] = [
    { id: "latency", expected: "Latency falls", observations: [{ ...positive, verdict: "observed" }], actions: [] },
    { id: "resources", expected: "Resource use falls", observations: [{ ...negative, verdict: "contradicted" }], actions: [action] },
    { id: "untested", expected: "Maintenance improves", observations: [], actions: [action] },
    { id: "disputed", expected: "Both explicit judgements remain visible", observations: [{ ...positive, verdict: "observed" }, { ...negative, verdict: "contradicted" }], actions: [] },
  ];
  const store = (declaration: unknown) => { const fields = { briefFollowThrough: JSON.stringify(declaration) }; return update(decision, { ...scope, ...fields }); };
  await store({ version: 1, adopted: true, outcomes });
  const brief = (tokenBudget = 64000) => buildDecisionFollowThroughBrief({ decision, tokenBudget }, options);
  return { workspace, pmRoot, client, options, scope, create, update, decision, observed, contradicted, action, positive, negative, outcomes, store, brief };
}
/** Capture authoritative tracker files; native disposable runtime caches are measured separately. */
async function snapshot(path: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!prefix && entry.name === "runtime") continue;
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(join(path, entry.name), `${name}/`));
    else if (!entry.isSymbolicLink()) result[name] = createHash("sha256").update(await readFile(join(path, entry.name))).digest("hex");
  }
  return result;
}

test("separate unsupported, observed, contradicted and conflicting outcomes without inferring success from closed work", async t => {
  const f = await fixture(t); const before = await snapshot(f.pmRoot);
  const brief = await f.brief();
  assert.deepEqual(await buildDecisionFollowThroughBrief({ decision: f.decision, tokenBudget: 64000 }, { pmRoot: f.pmRoot }), brief);
  assert.deepEqual(await readFollowThroughObservation(f.observed, { pmRoot: f.pmRoot }), f.positive);
  assert.deepEqual(brief.outcomes.map(row => row.state), ["observed", "contradicted", "unsupported", "conflicted"]);
  assert.equal(brief.outcomes[1].actions![0].state, "pending");
  assert.deepEqual(brief.outcomes[3].observations!.map(row => row.verdict), ["observed", "contradicted"]);
  assert.deepEqual(await snapshot(f.pmRoot), before);
  await f.update(f.action, { status: "closed", closeReason: "Finished work", resolution: "Complete", actualResult: "Done" });
  await f.update(f.decision, { status: "closed", closeReason: "Choice recorded" });
  const closed = await f.brief();
  assert.deepEqual(closed.outcomes.map(row => row.state), brief.outcomes.map(row => row.state));
  assert.equal(closed.outcomes[2].actions![0].state, "done");
  await f.store({ version: 1, adopted: false, outcomes: f.outcomes });
  await assert.rejects(f.brief(), refusal("not_adopted"));
});

test("only outcomes linked to a changed observation lose support, including ABA and replayed old declarations", async t => {
  const f = await fixture(t); const before = await f.brief();
  const saved = (await f.client.get(f.observed, { full: true })).item;
  await f.update(f.observed, { actualResult: "New observation contradicts the earlier interpretation" });
  const changed = await f.brief();
  assert.deepEqual(changed.outcomes.map(row => row.state), ["unsupported", "contradicted", "unsupported", "contradicted"]);
  assert.deepEqual(changed.outcomes[1], before.outcomes[1]); assert.deepEqual(changed.outcomes[2], before.outcomes[2]);
  assert.equal(changed.outcomes[0].observations![0].freshness, "changed");
  await f.update(f.observed, { actualResult: saved.actual_result });
  await f.store(JSON.parse(JSON.stringify({ version: 1, adopted: true, outcomes: f.outcomes })));
  assert.equal((await f.brief()).outcomes[0].state, "unsupported", "old content cannot revive a judgement bound to older history");
  const renewed = await readFollowThroughObservation(f.observed, f.options);
  const outcomes = structuredClone(f.outcomes); outcomes[0].observations[0].revision = renewed.revision;
  await f.store({ version: 1, adopted: true, outcomes });
  assert.equal((await f.brief()).outcomes[0].state, "observed");
});

test("missing and empty observations remain unsupported; malformed rows fail independently and foreign records remain untouched", async t => {
  const f = await fixture(t);
  const empty = await f.create("A closed observation without a measurement", { status: "closed", closeReason: "Administrative close" });
  const token = await readFollowThroughObservation(empty, f.options);
  await f.store({ version: 1, adopted: true, outcomes: [
    ...f.outcomes,
    { id: "missing", expected: "No evidence yet", observations: [{ item: "absent", revision: "0".repeat(64), verdict: "observed" }], actions: ["absent"] },
    { id: "empty", expected: "Closed status proves nothing", observations: [{ ...token, verdict: "observed" }], actions: [empty] },
    { id: "broken", expected: 5, observations: [], actions: [] },
    { id: "duplicate", expected: "First", observations: [], actions: [] },
    { id: "duplicate", expected: "Second", observations: [], actions: [] },
  ] });
  const foreignFields = { briefFollowThrough: JSON.stringify({ vendor: true }) };
  const foreign = await f.create("Foreign metadata", { ...f.scope, ...foreignFields });
  const foreignBefore = (await f.client.get(foreign, { full: true })).item;
  const result = await f.brief();
  assert.equal(result.outcomes[4].observations![0].freshness, "missing");
  assert.equal(result.outcomes[4].actions![0].state, "missing");
  assert.equal(result.outcomes[5].observations![0].freshness, "empty");
  assert.deepEqual(result.outcomes.slice(6).map(row => row.refusal?.code), ["invalid_outcome", "invalid_outcome", "invalid_outcome"]);
  assert.equal(result.outcomes[0].state, "observed");
  assert.deepEqual((await f.client.get(foreign, { full: true })).item, foreignBefore);
});

test("twenty outcome summaries fit 1500 estimated tokens with explicit whole-detail omissions", async t => {
  const f = await fixture(t);
  const outcomes = Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(f.outcomes[index % 4]), id: `outcome-${index}`, expected: "Long declared consequence. 測定😀\r\n".repeat(100) }));
  await f.store({ version: 1, adopted: true, outcomes });
  const result = await buildDecisionFollowThroughBrief({ decision: f.decision }, f.options);
  assert.equal(result.outcomes.length, 20); assert.ok(result.outcomes.every(row => row.omitted > 0));
  assert.ok(result.estimatedTokenCeiling <= 1500);
  assert.ok(estimatePmOutputTokens(Buffer.byteLength(JSON.stringify(result, null, 2))) <= result.estimatedTokenCeiling);
  const exact = await f.brief(result.estimatedTokenCeiling); assert.deepEqual(exact, result);
  await assert.rejects(f.brief(1), refusal("budget"));
  t.diagnostic(JSON.stringify({ outcomes: 20, budget: 1500, estimatedTokenCeiling: result.estimatedTokenCeiling, jsonBytes: Buffer.byteLength(JSON.stringify(result, null, 2)), omittedDetails: result.outcomes.reduce((sum, row) => sum + row.omitted, 0) }));
});

test("one boundary rejects sparse/accessor/proxy and extreme numeric inputs; producers validate and round-trip", async () => {
  const valid: FollowThroughDeclaration = { version: 1, adopted: true, outcomes: [{ id: "constructor", expected: " \r\nA valid historical declaration 測定😀\r\n ", observations: [], actions: ["constructor"] }] };
  assert.deepEqual(parseFollowThroughDeclaration(JSON.parse(JSON.stringify(valid))), valid);
  assert.deepEqual(parseFollowThroughRequest({ decision: "constructor" }), { decision: "constructor", tokenBudget: 1500 });
  let invoked = false;
  const badObject = Object.defineProperty({}, "decision", { get() { invoked = true; return "fixture"; } });
  const badArray = new Array(1); Object.defineProperty(badArray, 0, { get() { invoked = true; return valid.outcomes[0]; } });
  const inherited = new Array(1); Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: valid.outcomes[0] }));
  const sparseWithExtra = Object.assign(new Array(1), { noise: true });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [null, [], {}, new Date(), new Proxy({}, {}), revoked.proxy, badObject, { decision: "x", extra: 1 }, { decision: "x", [Symbol("extra")]: 1 }, { decision: "../escape" }, { decision: "x".repeat(201) }, { decision: "\0" }, { decision: " " }]) assert.throws(() => parseFollowThroughRequest(value), refusal("invalid"));
  const values: unknown[] = [NaN, Infinity, -Infinity, -1, 0, 0.5, 64001, Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, "1500", null];
  for (const tokenBudget of values) {
    await assert.rejects(buildDecisionFollowThroughBrief({ decision: "x", tokenBudget } as FollowThroughRequest, { pmRoot: "unreadable-before-validation" }), refusal("invalid"));
  }
  for (const value of [
    { ...valid, version: 2 }, { ...valid, adopted: "true" }, { ...valid, outcomes: [] }, { ...valid, outcomes: new Array(1) }, { ...valid, outcomes: badArray }, { ...valid, outcomes: inherited }, { ...valid, outcomes: sparseWithExtra }, { ...valid, outcomes: new Proxy([], {}) }, { ...valid, outcomes: Array.from({ length: 129 }, () => valid.outcomes[0]) },
    { ...valid, outcomes: [null] }, { ...valid, outcomes: [{ ...valid.outcomes[0], expected: "" }] }, { ...valid, outcomes: [{ ...valid.outcomes[0], expected: "x".repeat(16001) }] }, { ...valid, outcomes: [valid.outcomes[0], valid.outcomes[0]] },
    { ...valid, outcomes: [{ ...valid.outcomes[0], observations: [{ item: "x", revision: "0".repeat(64), verdict: "success" }] }] },
    { ...valid, outcomes: [{ ...valid.outcomes[0], observations: [{ item: "x", revision: "bad", verdict: "observed" }] }] },
    { ...valid, outcomes: [{ ...valid.outcomes[0], observations: Array.from({ length: 2 }, () => ({ item: "x", revision: "0".repeat(64), verdict: "observed" })) }] },
    { ...valid, outcomes: [{ ...valid.outcomes[0], actions: ["same", "same"] }] },
  ]) assert.throws(() => parseFollowThroughDeclaration(value), refusal("invalid"));
  assert.equal(invoked, false);
  const output: DecisionFollowThroughBrief = { protocol: "pm-brief.follow-through/v1", decision: "x", outcomes: [{ id: "x", state: "unsupported", omitted: 0 }], restore: "pm get x --full", estimatedTokenCeiling: 100 };
  validateFollowThroughAccounting(output, 1500);
  for (const value of values) {
    assert.throws(() => validateFollowThroughAccounting({ ...output, estimatedTokenCeiling: value as number }, 1500), refusal("budget"));
    if (value !== 0) assert.throws(() => validateFollowThroughAccounting({ ...output, outcomes: [{ ...output.outcomes[0], omitted: value as number }] }, 1500), refusal("budget"));
    assert.throws(() => validateFollowThroughAccounting(output, value as number), refusal("budget"));
  }
  assert.throws(() => validateFollowThroughAccounting({ ...output, outcomes: [{ ...output.outcomes[0], omitted: 66 }] }, 1500), refusal("budget"));
  let seed = 0xb01d1029;
  const bits = Buffer.alloc(8);
  for (let index = 0; index < 1000; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bits.writeUInt32BE(seed, 0);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bits.writeUInt32BE(seed, 4);
    const value = bits.readDoubleBE();
    if (Number.isSafeInteger(value) && value >= 1 && value <= 64000) assert.equal(parseFollowThroughRequest({ decision: "x", tokenBudget: value }).tokenBudget, value);
    else assert.throws(() => parseFollowThroughRequest({ decision: "x", tokenBudget: value }), refusal("invalid"));
    if (Number.isSafeInteger(value) && value >= 0 && value <= 65) validateFollowThroughAccounting({ ...output, outcomes: [{ ...output.outcomes[0], omitted: value }] }, 1500);
    else assert.throws(() => validateFollowThroughAccounting({ ...output, outcomes: [{ ...output.outcomes[0], omitted: value }] }, 1500), refusal("budget"));
  }
});

test("seeded 500 native operation sequences model replays, CRLF, every consumed field, relationships and random ambient/status registries", { timeout: 600000 }, async t => {
  const f = await fixture(t); let seed = 0x5eed1029;
  const random = (limit: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % limit; };
  const roles = ["active", "blocked", "terminal_done", "terminal_canceled"] as const;
  const statuses: string[] = [];
  for (let index = 0; index < 8; index++) {
    const status = `registry-${random(100000)}-${index}`;
    await f.client.schemaAddStatus(status, { role: [roles[random(roles.length)]] }); statuses.push(status);
  }
  const values = ["Measurement A", " Measurement B \r\nSecond line. 測定😀 ", " \r\n ", ""];
  const historical: FollowThroughDeclaration[] = [];
  const registry = resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema);
  const sources = [f.observed, f.contradicted]; let operations = 0; let replays = 0;
  const revisions = new Map([[f.observed, f.positive.revision], [f.contradicted, f.negative.revision]]);
  let persisted: FollowThroughDeclaration = { version: 1, adopted: true, outcomes: f.outcomes };
  for (let sequence = 0; sequence < 500; sequence++) {
    const source = sources[random(sources.length)]; const status = statuses[random(statuses.length)];
    const operation = random(6);
    // Checkpoint mutations keep native audit history bounded on the shared host;
    // every sequence still reads/evaluates real SDK state and replays randomized inputs.
    if (sequence % 8 === 0) {
    if (operation === 0) await f.update(source, { actualResult: values[random(values.length)] });
    if (operation === 1) await f.update(source, { body: values[random(values.length)], title: `Measurement ${random(99)}`, expectedResult: values[random(values.length)] });
    if (operation === 2) await f.update(source, { status, closeReason: "Model transition", dep: [`id=${f.action},kind=related_to`] });
    if (operation === 3) await f.update(f.action, { status, closeReason: "Model transition" });
    if (operation === 4) {
      await f.client.focus(sources[random(sources.length)]);
      await f.update(f.decision, { type: "Decision", status, closeReason: "Choice lifecycle is independent of adoption" }); operations++;
    }
    if (operation === 5) await f.update(source, { actualResult: values[random(values.length)], parent: f.action });
    operations++;
    revisions.set(source, (await readFollowThroughObservation(source, f.options)).revision);
    }
    const fresh = structuredClone(f.outcomes);
    for (const row of fresh) {
      row.expected = `${values[random(values.length)]}Declared consequence ${row.id}`;
      for (const observation of row.observations) {
        observation.revision = revisions.get(observation.item)!;
        observation.verdict = random(2) ? "observed" : "contradicted";
      }
    }
    const declaration: FollowThroughDeclaration = parseFollowThroughDeclaration({ version: 1, adopted: true, outcomes: fresh });
    assert.deepEqual(parseFollowThroughDeclaration(JSON.parse(JSON.stringify(declaration))), declaration);
    historical.push(declaration);
    const selected = random(3) === 0 ? historical[random(historical.length)] : declaration;
    if (sequence % 8 === 0) {
      if (selected !== declaration) replays++;
      await f.store(selected); persisted = selected; operations++;
    }
    const native = new Map((await f.client.listAllComplete({ includeBody: true })).items.map(row => [row.id, row]));
    const decisionBefore = native.get(f.decision)!;
    assert.ok(!decisionBefore.parent && !decisionBefore.sprint && !decisionBefore.release, "ambient focus cannot supply scope");
    const readBack = parseFollowThroughDeclaration(decisionBefore.brief_follow_through);
    assert.deepEqual(readBack, persisted, "compare SDK read-back, never a handwritten normalization");
    const result = await f.brief();
    // Independent set model: only current, nonempty native observations contribute their explicit verdict.
    const expected = readBack.outcomes.map(row => {
      const judgements = new Set(row.observations.filter(observation => observation.revision === revisions.get(observation.item) && Boolean(native.get(observation.item)!.actual_result?.trim())).map(observation => observation.verdict));
      return judgements.size === 2 ? "conflicted" : judgements.size === 0 ? "unsupported" : [...judgements][0];
    });
    assert.deepEqual(result.outcomes.map(row => row.state), expected, `sequence ${sequence}`);
    const action = native.get(f.action)!; const actionRoles = registry.by_id.get(action.status)!.roles;
    const actionState = actionRoles.includes("terminal_canceled") ? "canceled" : actionRoles.includes("terminal_done") ? "done" : actionRoles.includes("terminal") ? "terminal" : actionRoles.includes("blocked") ? "blocked" : "pending";
    assert.equal(result.outcomes[2].actions![0].state, actionState);
    assert.deepEqual((await f.client.listAllComplete({ includeBody: true })).items, [...native.values()]);
    validateFollowThroughAccounting(result, 64000); assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
  assert.ok(replays > 10);
  t.diagnostic(JSON.stringify({ seed: "0x5eed1029", sequences: 500, operations, historicalReplays: replays, customStatuses: statuses.length }));
});

test("interleavings at both native read boundaries refuse stale output and report the peer state on retry", async t => {
  const f = await fixture(t);
  for (const boundary of [0, 1, 2, 3, 4]) {
    const competing = new PmClient({ pmRoot: f.pmRoot, author: "peer", noExtensions: true });
    const read = competing.listAllComplete.bind(competing); let reads = 0;
    competing.listAllComplete = async options => {
      const ordinal = reads++;
      if (boundary === 2 && ordinal === 1) await f.update(f.action, { description: `Peer before read ${boundary}` });
      if (boundary === 3 && ordinal === 1) await f.client.comments(f.observed, { add: `Peer history before read ${boundary}` });
      const result = await read(options);
      if (boundary === 0 && ordinal === 0) await f.update(f.action, { description: `Peer after read ${boundary}` });
      if (boundary === 1 && ordinal === 0) await f.client.comments(f.observed, { add: `Peer history after read ${boundary}` });
      if (boundary === 4 && ordinal === 1) await f.client.comments(f.observed, { add: `Peer history after final snapshot ${boundary}` });
      return result;
    };
    await assert.rejects(buildDecisionFollowThroughBrief({ decision: f.decision, tokenBudget: 64000 }, { pmRoot: f.pmRoot, client: competing }), refusal("changed"));
    assert.equal((await f.brief()).outcomes[0].state, boundary === 0 ? "observed" : "unsupported");
  }
  for (const boundary of [0, 1]) {
    const competing = new PmClient({ pmRoot: f.pmRoot, author: "peer", noExtensions: true });
    const read = competing.listAllComplete.bind(competing); let reads = 0;
    competing.listAllComplete = async options => {
      const ordinal = reads++;
      if (boundary === 1 && ordinal === 1) await f.update(f.observed, { actualResult: "Changed before reread" });
      const result = await read(options);
      if (boundary === 0 && ordinal === 0) await f.update(f.observed, { actualResult: "Changed after read" });
      return result;
    };
    await assert.rejects(readFollowThroughObservation(f.observed, { pmRoot: f.pmRoot, client: competing }), refusal("changed"));
    assert.match((await readFollowThroughObservation(f.observed, f.options)).revision, /^[a-f0-9]{64}$/);
  }
});

test("typed refusal corpus includes previously valid unannotated items and missing or damaged trackers", async t => {
  const f = await fixture(t);
  for (const decision of [f.action, await f.create("Historical unannotated Decision", { type: "Decision" })]) await assert.rejects(buildDecisionFollowThroughBrief({ decision }, f.options), refusal("not_adopted"));
  await assert.rejects(buildDecisionFollowThroughBrief({ decision: "absent" }, f.options), refusal("missing"));
  await assert.rejects(readFollowThroughObservation("absent", f.options), refusal("missing"));
  await assert.rejects(buildDecisionFollowThroughBrief({ decision: f.decision }, { pmRoot: join(f.workspace, "missing") }), refusal("tracker"));
  await assert.rejects(readFollowThroughObservation(f.observed, { pmRoot: join(f.workspace, "missing") }), refusal("tracker"));
  const path = getHistoryPath(f.pmRoot, f.observed); const saved = await readFile(path);
  try {
    await writeFile(path, ""); await assert.rejects(readFollowThroughObservation(f.observed, f.options), refusal("tracker"));
    const unreadable = await f.brief();
    assert.equal(unreadable.outcomes[0].state, "unsupported");
    assert.equal(unreadable.outcomes[0].observations![0].freshness, "unreadable");
    assert.equal(unreadable.outcomes[1].state, "contradicted");
    await writeFile(path, "invalid history\n");
    await assert.rejects(readFollowThroughObservation(f.observed, f.options), refusal("tracker"));
    assert.equal((await f.brief()).outcomes[0].observations![0].freshness, "unreadable");
  } finally { await writeFile(path, saved); }
  assert.equal((await f.brief()).outcomes[0].state, "observed");
});

test("configured status roles handle arbitrary custom names and misleading built-in names", async t => {
  const f = await fixture(t);
  for (const [index, role] of ["active", "blocked", "terminal_done", "terminal_canceled", "terminal"].entries()) {
    const status = `random-${731 + index * 719}`;
    await f.client.schemaAddStatus(status, { role: [role] });
    await f.update(f.action, { status, closeReason: "Role fixture" });
    assert.equal((await f.brief()).outcomes[2].actions![0].state, ["pending", "blocked", "done", "canceled", "terminal"][index]);
  }
  await f.client.schemaAddStatus("done", { role: ["active"] });
  await f.update(f.action, { status: "done" });
  assert.equal((await f.brief()).outcomes[2].actions![0].state, "pending");
  assert.equal((await f.brief()).outcomes[2].state, "unsupported");
});

test("real native non-git CLI emits JSON/TOON and injected handlers share the schema and remedies", async t => {
  const f = await fixture(t);
  await f.store({ version: 1, adopted: true, outcomes: Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(f.outcomes[index % 4]), id: `outcome-${index}`, expected: "Long declared consequence. 測定😀\r\n".repeat(100) })) });
  const extensionRoot = join(f.pmRoot, "extensions/pm-brief"); await mkdir(extensionRoot, { recursive: true });
  for (const file of ["manifest.json", "package.json"]) await cp(join(root, file), join(extensionRoot, file));
  await cp(join(root, "dist"), join(extensionRoot, "dist"), { recursive: true }); await symlink(join(root, "node_modules"), join(extensionRoot, "node_modules"));
  await mkdir(join(f.workspace, "bin")); await symlink(process.execPath, join(f.workspace, "bin/node")); await mkdir(join(f.workspace, "home"));
  const run = (args: string[]) => spawnSync(process.execPath, [join(root, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", f.pmRoot, ...args], { cwd: f.workspace, env: { ...process.env, PATH: join(f.workspace, "bin"), GIT_CEILING_DIRECTORIES: dirname(f.workspace), HOME: join(f.workspace, "home") }, encoding: "utf8", timeout: 120000 });
  const before = await snapshot(f.pmRoot);
  for (const format of ["json", "toon"]) {
    const result = run([...(format === "json" ? ["--json"] : []), "brief", "follow-through", f.decision]);
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(result.stderr, "");
    assert.match(result.stdout, /pm-brief.follow-through\/v1/); assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= 1500);
    if (format === "json") assert.equal((JSON.parse(result.stdout) as DecisionFollowThroughBrief).outcomes.length, 20);
    t.diagnostic(JSON.stringify({ fixtureOutcomes: 20, format, emittedBytes: Buffer.byteLength(result.stdout), estimatedTokens: estimatePmOutputTokens(Buffer.byteLength(result.stdout)) }));
  }
  const token = run(["--json", "brief", "observation", f.observed]); assert.equal(token.status, 0, token.stderr); assert.deepEqual(JSON.parse(token.stdout), f.positive);
  for (const suffix of [["--token-budget", "Infinity"], ["--token-budget", ""], ["--token-budget", "1"], ["--token-budget", " 1500 "]]) {
    const result = run(["--json", "brief", "follow-through", f.decision, ...suffix]); assert.equal(result.status, 2); assert.match(result.stdout + result.stderr, /follow_through_(invalid|budget)/);
  }
  assert.deepEqual(await snapshot(f.pmRoot), before);
  const harness = await createExtensionTestHarness(extension, { name: "pm-brief", capabilities: ["commands", "services", "schema"] });
  t.after(() => harness.deactivate());
  const registered = await harness.runCommand({ command: "brief follow-through", args: [f.decision], pmRoot: f.pmRoot, options: { tokenBudget: "64000" } });
  assert.equal((registered.result as DecisionFollowThroughBrief).outcomes[0].state, "observed");
  assert.deepEqual((await harness.runCommand({ command: "brief observation", args: [f.observed], pmRoot: f.pmRoot })).result, f.positive);
  for (const args of [[], [f.decision, "extra"]]) await assert.rejects(harness.runCommand({ command: "brief follow-through", args, pmRoot: f.pmRoot }), /follow-through invalid/);
  await assert.rejects(harness.runCommand({ command: "brief follow-through", args: [f.decision], pmRoot: f.pmRoot, options: { tokenBudget: 1 } }), /follow-through invalid/);
});
