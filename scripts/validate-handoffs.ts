/** Read-only real-data measurement: supply the storage root of a disposable public tracker snapshot. */
import { PmClient, certifyCompleteListResult } from "@unbrained/pm-cli/sdk";
import { previewHandoff } from "../handoff.ts";
import type { HandoffContract } from "../handoff.ts";

/** Measure complete source size, bounded packet size, blocker coverage and elapsed generation time. */
async function main(args: string[]): Promise<void> {
  if (args.length !== 1) throw new Error("Supply exactly one public tracker storage root");
  const pmRoot = args[0]!;
  const client = new PmClient({ pmRoot, noExtensions: true });
  const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
  const sample = items.filter(item => item.status !== "closed" && item.status !== "canceled").slice(0, 5);
  if (sample.length === 0) throw new Error("The public tracker needs at least one active item");
  const elapsed: number[] = []; const sizes: number[] = []; const ceilings: number[] = [];
  let revisionRows = 0; let missingRequirements = 0;
  for (const item of sample) {
    const contract: HandoffContract = { focus: [item.id], questions: [{ id: "scope", text: "Which public evidence supports this work?" }], assumptions: [{ id: "pending", text: "Recorded blockers still require verification." }], requiredEvidence: [{ id: "report", item: item.id, kind: "docs", ref: "docs/handoff-required-evidence.md" }] };
    const started = performance.now();
    const packet = await previewHandoff(contract, { pmRoot, author: "validation-agent", tokenBudget: 64000 });
    elapsed.push(performance.now() - started); sizes.push(Buffer.byteLength(JSON.stringify(packet))); ceilings.push(packet.estimatedTokenCeiling);
    revisionRows += packet.contract.items.length; missingRequirements += packet.missingEvidence.length;
  }
  elapsed.sort((a, b) => a - b);
  console.log(JSON.stringify({ source: "public pm-brief tracker snapshot", trackerItems: items.length, packets: sample.length, revisionRows, missingRequirements, compactJsonBytes: { min: Math.min(...sizes), max: Math.max(...sizes), total: sizes.reduce((sum, size) => sum + size, 0) }, conservativeTokenCeiling: { min: Math.min(...ceilings), max: Math.max(...ceilings) }, elapsedMs: { median: Math.round(elapsed[Math.floor(elapsed.length / 2)]!), max: Math.round(Math.max(...elapsed)) }, mode: "read-only preview" }, null, 2));
}
await main(process.argv.slice(2));
