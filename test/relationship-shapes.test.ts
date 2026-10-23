import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PmClient, certifyCompleteListResult, locateItem, readLocatedItem, serializeItemDocument, type Dependency } from "@unbrained/pm-cli/sdk";
import { buildBrief, explainNextItems, selectNextItems, summarizeRisks } from "../index.ts";

type SymbolId = "a" | "b" | "missing";
type Edge = readonly [SymbolId, SymbolId, boolean?];
type Kind = "blocks" | "blocked_by" | "parent" | "related" | "depends_on";

/** Imported records may contain self edges and duplicates forbidden by today's mutation API. */
async function importDependencies(pmRoot: string, id: string, dependencies: Dependency[], blockedBy?: string): Promise<void> {
  const located = await locateItem(pmRoot, id);
  assert.ok(located);
  const { document } = await readLocatedItem(located);
  document.metadata.dependencies = dependencies;
  if (blockedBy !== undefined) document.metadata.blocked_by = blockedBy;
  await writeFile(located.itemPath, serializeItemDocument(document));
}

// Expected blocker orientation and namespaces are explicit for each graph shape.
// parent/related carry context only, regardless of target lifecycle or provenance.
const shapes: Array<{
  name: string; target: SymbolId; present: boolean; terminal?: boolean;
  localDirect: Edge[]; localReverse: Edge[]; externalDirect: Edge[]; externalReverse?: Edge[];
}> = [
  { name: "open", target: "b", present: true, localDirect: [["a", "b"]], localReverse: [["b", "a"]], externalDirect: [["a", "b", true]] },
  { name: "terminal", target: "b", present: true, terminal: true, localDirect: [], localReverse: [["b", "a"]], externalDirect: [["a", "b", true]] },
  { name: "missing", target: "missing", present: false, localDirect: [["a", "missing"]], localReverse: [], externalDirect: [["a", "missing", true]] },
  { name: "self", target: "a", present: false, localDirect: [["a", "a"]], localReverse: [["a", "a"]], externalDirect: [["a", "a", true]] },
  { name: "cycle", target: "b", present: true, localDirect: [["a", "b"], ["b", "a"]], localReverse: [["b", "a"], ["a", "b"]], externalDirect: [["a", "b", true], ["b", "a", true]] },
  { name: "duplicate", target: "b", present: true, localDirect: [["a", "b"]], localReverse: [["b", "a"]], externalDirect: [["a", "b", true]] },
  { name: "collision", target: "b", present: true, localDirect: [["a", "b"], ["a", "b", true]], localReverse: [["b", "a"]], externalDirect: [["a", "b"], ["a", "b", true]], externalReverse: [["b", "a"]] },
];

for (const kind of ["blocks", "blocked_by", "parent", "related", "depends_on"] as const) {
  for (const sourceKind of [undefined, "local", "global", "external"] as const) {
    for (const shape of shapes) {
      test(`SDK relationship matrix: ${kind}/${sourceKind ?? "implicit-local"}/${shape.name}`, async (t) => {
        const workspace = await mkdtemp(join(tmpdir(), "brief-shapes-"));
        t.after(() => rm(workspace, { recursive: true, force: true }));
        const pmRoot = join(workspace, ".agents/pm");
        const client = new PmClient({ cwd: workspace, pmRoot, noExtensions: true, author: "fixture" });
        await client.init("fixture", { defaults: true, agentGuidance: "skip", mergeFence: false });
        const a = (await client.create({ type: "Task", title: "Source" })).item.id;
        const b = shape.present ? (await client.create({ type: "Task", title: "Target", ...(shape.terminal ? { status: "closed", closeReason: "Complete" } : {}) })).item.id : "fixture-absent";
        const ids = { a, b, missing: "fixture-missing" };
        const external = sourceKind === "global" || sourceKind === "external";
        const dependency: Dependency = { id: ids[shape.target], kind, ...(sourceKind ? { source_kind: sourceKind } : {}) };
        const dependencies = shape.name === "duplicate" ? [dependency, { ...dependency }] : shape.name === "collision"
          ? [dependency, { id: b, kind, ...(external ? {} : { source_kind: "global" }) }] : [dependency];
        await importDependencies(pmRoot, a, dependencies);
        if (shape.name === "cycle") await importDependencies(pmRoot, b, [{ ...dependency, id: a }]);
        const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
        assert.equal(items.find(item => item.id === a)?.dependencies?.length, dependencies.length, "the real SDK read must preserve the fixture shape");
        const expected: Edge[] = kind === "blocked_by" || kind === "depends_on" ? (external ? shape.externalDirect : shape.localDirect)
          : kind === "blocks" ? (external ? shape.externalReverse ?? [] : shape.localReverse) : [];
        const options = { tokenBudget: 64000, focusIds: items.map(item => item.id), includeClosed: true };
        const brief = buildBrief(items, options);
        const blocked = new Set(expected.map(([from]) => ids[from]));
        const ready = items.filter(item => item.status !== "closed" && !blocked.has(item.id)).map(item => item.id).sort();
        assert.deepEqual(brief.next.map(item => item.id).sort(), ready, "brief next contains exactly the ready active work");
        assert.deepEqual(selectNextItems(items).map(item => item.id).sort(), ready, "standalone next agrees");
        assert.deepEqual(brief.blockers.map(edge => JSON.stringify([edge.itemId, edge.blockedBy, edge.title, edge.status])).sort(), expected.map(([from, to, isExternal]) => {
          const target = isExternal ? undefined : items.find(item => item.id === ids[to]);
          return JSON.stringify([ids[from], ids[to], target?.title, target?.status]);
        }).sort(), "blocker evidence retains direction, target status and namespace");
        for (const row of brief.focus) {
          assert.equal(row.rankingReasons.some(reason => reason.startsWith("blocked_by_active_dependency:")), blocked.has(row.id), "focus readiness agrees with blocker output");
          const count = new Set(expected.filter(([from]) => ids[from] === row.id).map(([, to, isExternal]) => JSON.stringify([ids[to], isExternal === true]))).size;
          if (count) assert.ok(row.rankingReasons.includes(`active_dependencies:${count}`), "ranking counts distinct blocker namespaces once each");
        }
        const risks = summarizeRisks(items).filter(risk => risk.severity === "high").map(risk => risk.itemId).sort();
        assert.deepEqual(risks, items.filter(item => item.status !== "closed" && blocked.has(item.id)).map(item => item.id).sort());
        const explanations = explainNextItems(items);
        assert.deepEqual(explanations.map(row => row.item.id).sort(), ready);
        for (const row of explanations) {
          assert.equal(row.activeDependencies, 0);
          const dependents = new Set(expected.filter(([from, to, isExternal]) => !isExternal && ids[to] === row.item.id && items.some(item => item.id === ids[from] && item.status !== "closed")).map(([from]) => ids[from]));
          assert.equal(row.activeDependents, dependents.size);
          assert.equal(row.score.dependents, dependents.size * 8);
        }
      });
    }
  }
}

for (const kind of ["blocks", "blocked_by", "parent", "related", "depends_on"] satisfies Kind[]) {
  test(`SDK relationship matrix: ${kind}/URI`, async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "brief-uri-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const pmRoot = join(workspace, ".agents/pm");
    const client = new PmClient({ cwd: workspace, pmRoot, noExtensions: true, author: "fixture" });
    await client.init("fixture", { defaults: true, agentGuidance: "skip", mergeFence: false });
    const target = "github:fixture/project#1";
    const source = (await client.create({ type: "Task", title: "Source", dep: [`id=${target},kind=${kind}`], allowUnresolvedDeps: true })).item.id;
    const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    const brief = buildBrief(items, { tokenBudget: 64000 });
    const blocking = kind === "blocked_by" || kind === "depends_on";
    assert.deepEqual(brief.next.map(item => item.id), blocking ? [] : [source]);
    assert.deepEqual(selectNextItems(items).map(item => item.id), brief.next.map(item => item.id));
    assert.deepEqual(brief.blockers.map(edge => [edge.itemId, edge.blockedBy, edge.status]), blocking ? [[source, target, undefined]] : []);
  });
}

for (const shape of ["local", "duplicate", "collision", "missing", "self", "URI", "sentinel"] as const) {
  test(`SDK relationship matrix: scalar blocked_by/${shape}`, async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "brief-scalar-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const pmRoot = join(workspace, ".agents/pm");
    const client = new PmClient({ cwd: workspace, pmRoot, noExtensions: true, author: "fixture" });
    await client.init("fixture", { defaults: true, agentGuidance: "skip", mergeFence: false });
    const source = (await client.create({ type: "Task", title: "Source" })).item.id;
    const target = (await client.create({ type: "Task", title: "Target" })).item.id;
    const scalar = shape === "self" ? source : shape === "missing" ? "fixture-missing" : shape === "URI" ? "github:fixture/project#1" : shape === "sentinel" ? "no-active-blocker" : target;
    const dependencies = shape === "duplicate" || shape === "collision" ? [{ id: target, kind: "blocked_by", ...(shape === "collision" ? { source_kind: "global" } : {}) }] : [];
    await importDependencies(pmRoot, source, dependencies, scalar);
    const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    assert.equal(items.find(item => item.id === source)?.blocked_by, scalar);
    const brief = buildBrief(items, { tokenBudget: 64000, focusIds: [source] });
    const ready = shape === "sentinel" ? [source, target].sort() : [target];
    assert.deepEqual(brief.next.map(item => item.id).sort(), ready);
    assert.deepEqual(selectNextItems(items).map(item => item.id).sort(), ready);
    assert.equal(brief.blockers.length, shape === "sentinel" ? 0 : shape === "collision" ? 2 : 1);
    if (shape === "collision") {
      assert.deepEqual(brief.blockers.map(edge => edge.status), ["open", undefined]);
      assert.ok(brief.focus[0].rankingReasons.includes("active_dependencies:2"));
    }
  });
}
