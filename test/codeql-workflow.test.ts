import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const codeqlWorkflow = readFileSync(
  new URL("../.github/workflows/codeql.yml", import.meta.url),
  "utf8",
);
const dependabotConfig = readFileSync(
  new URL("../.github/dependabot.yml", import.meta.url),
  "utf8",
);

test("every CodeQL action uses one pinned release", () => {
  const workflow = parse(codeqlWorkflow) as {
    jobs?: Record<string, { steps?: Array<{ uses?: unknown }> }>;
  };
  const references: string[] = [];

  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses !== "string" || !step.uses.startsWith("github/codeql-action/")) continue;
      const reference = /^github\/codeql-action\/[^@\s]+@([^\s]+)$/.exec(step.uses);
      assert.ok(reference, `invalid CodeQL action reference: ${step.uses}`);
      references.push(reference[1]);
    }
  }

  assert.ok(references.length > 1, "the workflow should use multiple CodeQL actions");
  assert.ok(
    references.every((reference) => /^[0-9a-f]{40}$/.test(reference)),
    "every CodeQL action must use a pinned commit SHA",
  );
  assert.equal(new Set(references).size, 1, "all CodeQL actions must use the same release");
});

test("Dependabot groups CodeQL action updates", () => {
  const config = parse(dependabotConfig) as {
    updates?: Array<{
      "package-ecosystem"?: unknown;
      groups?: { "codeql-action"?: { patterns?: unknown } };
    }>;
  };
  const githubActions = config.updates?.find(
    (update) => update["package-ecosystem"] === "github-actions",
  );

  assert.ok(githubActions, "Dependabot should configure the github-actions ecosystem");
  assert.deepEqual(githubActions.groups?.["codeql-action"]?.patterns, [
    "github/codeql-action*",
  ]);
});
