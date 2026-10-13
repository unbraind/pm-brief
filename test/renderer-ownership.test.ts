import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";

/** Exercise document ownership through the installed SDK service chain. */
test("output service preserves owned documents and declines foreign or structured results", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-brief", capabilities: ["commands", "services", "schema"] });
  try {
    const owned = { pmBriefRendered: true, output: "# brief\n" };
    const commands = ["brief", "brief prompt", "brief next", "brief stale", "brief momentum", "brief since", "brief diverge", "brief duplicates", "brief governance"];
    assert.deepEqual(harness.activation.registrations.commands.map((entry) => entry.command).sort(), [...commands].sort());
    for (const command of commands) {
      const result = await harness.runServiceOverride({ service: "output_format", command, payload: { result: owned } });
      assert.equal(result.handled, true);
      assert.equal(result.result, owned.output);
    }
    for (const command of [undefined, "context-pack", "brief"]) {
      for (const result of [undefined, null, "text", {}, { output: "x" }, { pmBriefRendered: false, output: "x" }, { pmBriefRendered: true, output: 1 }, { items: [] }]) {
        const decision = await harness.runServiceOverride({ service: "output_format", command, payload: { result } });
        assert.equal(decision.handled, false);
      }
    }
    assert.equal((await harness.runServiceOverride({ service: "output_format", command: "context-pack", payload: { result: owned } })).handled, false);
    assert.equal((await harness.runServiceOverride({ service: "output_format", command: "brief", payload: undefined })).handled, false);
  } finally { await harness.deactivate(); }
});
