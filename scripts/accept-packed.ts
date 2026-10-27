import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HandoffPacket, HandoffStatus } from "../handoff.ts";
import type { DecisionAlternativesDigest } from "../alternatives.ts";
import type { DisclosureResult } from "../disclosure.ts";
import type { ActionPrerequisiteBrief } from "../action.ts";

/** Package fields that define the packed acceptance matrix. */
interface PackageContract {
  readonly name: string;
  readonly version: string;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

/** One package-manager and host-version combination exercised from a fresh
 * project rather than from this repository's installed dependency graph. */
interface AcceptanceScenario {
  readonly name: string;
  readonly manager: "npm" | "bun";
  readonly hostVersion: string;
  /** Exercise the actual global host bin symlink inside a disposable prefix. */
  readonly global?: boolean;
}

/** Concise receipt emitted for each successfully loaded packed extension. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly fixture_present: true;
  readonly bounded_estimate: number;
  readonly cannot_fit_exit_code: 2;
  /** Both receivers survive native append-only writes on a plain tracker. */
  readonly handoff_receivers: 2;
  /** Deliberately missing required linkage remains visible after acknowledgment. */
  readonly handoff_missing_evidence: true;
  /** Packed command preserves two independently cited records within its budget. */
  readonly decision_alternatives: 2;
  /** All audiences and a value-free dry run execute from the installed tarball. */
  readonly disclosure_profiles: 3;
  /** One call retains missing close fields and native prerequisites without applying an action. */
  readonly action_prerequisites: true;
}

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as PackageContract;
const cliPackage = "@unbrained/pm-cli";
const developmentVersion = packageJson.devDependencies[cliPackage];
const minimumVersion = packageJson.peerDependencies[cliPackage]?.replace(/^>=/, "");
if (!developmentVersion || !minimumVersion) {
  throw new Error(`package.json must declare exact development and minimum peer versions for ${cliPackage}`);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const bunxCommand = process.platform === "win32" ? "bunx.exe" : "bunx";
const cleanEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  npm_config_userconfig: devNull,
  NPM_CONFIG_USERCONFIG: devNull,
};
for (const key of Object.keys(cleanEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete cleanEnvironment[key];
}

/** Run one acceptance command without a shell and fail with bounded diagnostics.
 *
 * @param command - Executable resolved directly by the operating system.
 * @param args - Argument vector passed without interpolation.
 * @param cwd - Fresh scenario directory or the package root.
 * @returns Captured UTF-8 stdout and stderr for contract assertions.
 */
function run(command: string, args: string[], cwd: string, allowFailure = false, environment = cleanEnvironment): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}: ${(result.stderr || result.error?.message || result.stdout).trim()}`,
    );
  }
  return result;
}

/** Invoke the scenario-local pm binary through npx or bunx, proving both
 * user-facing launchers resolve the installed CLI and extension graph.
 *
 * @param scenario - Package manager and host version under acceptance.
 * @param cwd - Fresh project holding only the packed package and chosen host.
 * @param args - pm arguments after the executable name.
 * @returns Captured pm process result.
 */
function runPm(scenario: AcceptanceScenario, cwd: string, args: string[], allowFailure = false): SpawnSyncReturns<string> {
  // --silent keeps npm's own runner off stderr. From npm 11 the runner writes a
  // progress notice there, which says nothing about the package; silencing the
  // runner is better than filtering its output afterwards, because any filter
  // wide enough to catch the notice is also wide enough to discard a diagnostic
  // the installed host or extension printed -- exactly what this gate exists to
  // catch.
  if (scenario.global) return run(join(cwd, "global", "bin", "pm"), ["--pm-path", ".agents/pm", ...args], cwd, allowFailure);
  return scenario.manager === "npm"
    ? run(npxCommand, ["--no-install", "--silent", "pm", "--pm-path", ".agents/pm", ...args], cwd, allowFailure)
    : run(bunxCommand, ["--no-install", "pm", "--pm-path", ".agents/pm", ...args], cwd, allowFailure);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pm-brief-packed-acceptance-"));
try {
  const packRoot = join(temporaryRoot, "pack");
  mkdirSync(packRoot);
  run(npmCommand, ["pack", "--silent", "--pack-destination", packRoot], repoRoot);
  const tarball = join(packRoot, `${packageJson.name}-${packageJson.version}.tgz`);
  const scenarios: AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", hostVersion: developmentVersion },
    { name: "bun-current", manager: "bun", hostVersion: developmentVersion },
    { name: "npm-minimum", manager: "npm", hostVersion: minimumVersion },
    { name: "npm-global", manager: "npm", hostVersion: developmentVersion, global: true },
    { name: "bun-global", manager: "bun", hostVersion: developmentVersion, global: true },
  ];
  const receipts: AcceptanceReceipt[] = [];

  for (const scenario of scenarios) {
    const scenarioRoot = join(temporaryRoot, scenario.name);
    mkdirSync(scenarioRoot);
    if (scenario.global) {
      const prefix = join(scenarioRoot, "global");
      if (scenario.manager === "npm") run(npmCommand, ["install", "--global", "--prefix", prefix, "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
      else {
        const config = join(scenarioRoot, "bunfig.toml");
        writeFileSync(config, `[install]\nglobalDir = ${JSON.stringify(join(prefix, "lib"))}\nglobalBinDir = ${JSON.stringify(join(prefix, "bin"))}\n`);
        run(bunCommand, ["add", "--global", `--config=${config}`, "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot, false, { ...cleanEnvironment, BUN_INSTALL_GLOBAL_DIR: join(prefix, "lib"), BUN_INSTALL_BIN: join(prefix, "bin") });
      }
    } else if (scenario.manager === "npm") {
      run(npmCommand, ["init", "-y"], scenarioRoot);
      run(npmCommand, ["install", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
    } else {
      run(bunCommand, ["init", "-y"], scenarioRoot);
      run(bunCommand, ["add", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
    }

    runPm(scenario, scenarioRoot, ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"]);
    const fixtureTitle = `Validate packed pm-brief ${scenario.name}`;
    const created = runPm(scenario, scenarioRoot, [
      "--json",
      "create",
      "task",
      fixtureTitle,
      "--description",
      "Installed-package acceptance fixture",
      "--status",
      "open",
      "--priority",
      "1",
      "--create-mode",
      "progressive",
    ]);
    runPm(scenario, scenarioRoot, ["install", tarball, "--project"]);
    const brief = runPm(scenario, scenarioRoot, ["--json", "brief", "--no-governance"]);
    const parsed: unknown = JSON.parse(brief.stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${scenario.name} pm brief stdout was not a JSON object`);
    }
    if (!brief.stdout.includes(fixtureTitle)) {
      throw new Error(`${scenario.name} pm brief omitted its real tracker fixture`);
    }
    // What this asserts is that the INSTALLED extension is silent on stderr, so
    // a consumer piping `pm --json brief` gets clean output.
    // Nothing is filtered out of this: the runner is silenced at the source, so
    // anything left on stderr came from the installed package.
    if (brief.stderr !== "") {
      throw new Error(`${scenario.name} pm brief emitted unexpected stderr: ${brief.stderr.trim()}`);
    }
    const bounded = runPm(scenario, scenarioRoot, ["brief", "--no-governance", "--format", "markdown", "--max-tokens", "1000"]);
    const boundedEstimate = Math.ceil(bounded.stdout.length / 4);
    if (boundedEstimate > 1000) throw new Error(`${scenario.name} rendered brief exceeds 1000: ${boundedEstimate}`);
    const refused = runPm(scenario, scenarioRoot, ["brief", "--no-governance", "--max-tokens", "1"], true);
    if (refused.status !== 2 || !/minimum budget \d+ required; run pm brief/.test(refused.stdout + refused.stderr)) {
      throw new Error(`${scenario.name} cannot-fit must preserve usage exit 2 and recovery: ${String(refused.status)} ${(refused.stderr || refused.stdout).trim()}`);
    }
    const createdReceipt = JSON.parse(created.stdout) as { id?: string; item?: { id?: string } };
    const fixtureId = createdReceipt.id ?? createdReceipt.item?.id;
    if (!fixtureId) throw new Error(`${scenario.name} create did not return a fixture id`);
    const nativeBefore = runPm(scenario, scenarioRoot, ["--json", "get", fixtureId, "--full"]).stdout;
    for (const format of ["json", "toon"]) {
      const preview = runPm(scenario, scenarioRoot, [...(format === "json" ? ["--json"] : []), "brief", "action", "close", fixtureId]);
      if (!preview.stdout.includes("actual_result") || Buffer.byteLength(preview.stdout) > 16000 || preview.stderr !== "") throw new Error(`${scenario.name} prerequisite preview lost close fields or exceeded budget`);
      if (format === "json") {
        const output = JSON.parse(preview.stdout) as ActionPrerequisiteBrief;
        if (!output.preview || output.ready || output.refusals.length || output.estimatedTokenCeiling > 4000) throw new Error(`${scenario.name} prerequisite preview contract failed`);
      }
    }
    if (runPm(scenario, scenarioRoot, ["--json", "get", fixtureId, "--full"]).stdout !== nativeBefore) throw new Error(`${scenario.name} prerequisite preview mutated its target`);
    const contractFile = join(scenarioRoot, "handoff-contract.json");
    writeFileSync(contractFile, JSON.stringify({ focus: [fixtureId], questions: [{ id: "scope", text: "Which fixture will you use?" }], assumptions: [{ id: "review", text: "Review is unresolved" }], requiredEvidence: [{ id: "report", item: fixtureId, kind: "docs", ref: "docs/report.md" }] }));
    const packet = JSON.parse(runPm(scenario, scenarioRoot, ["--json", "--author", "packed-sender", "brief", "handoff", "create", "--input", contractFile]).stdout) as HandoffPacket;
    const responseFile = join(scenarioRoot, "handoff-response.json");
    writeFileSync(responseFile, JSON.stringify({ digest: packet.digest, questions: { scope: "The installed public fixture" }, assumptions: { review: "Unresolved; verify first" }, evidence: { report: "Missing; do not infer validation" } }));
    for (const receiver of ["packed-a", "packed-b"]) runPm(scenario, scenarioRoot, ["--json", "--author", receiver, "brief", "handoff", "ack", packet.id, "--input", responseFile]);
    const handoff = JSON.parse(runPm(scenario, scenarioRoot, ["--json", "brief", "handoff", "show", packet.id]).stdout) as HandoffStatus;
    if (handoff.receipts.length !== 2 || handoff.receipts.some(row => !row.valid || row.ready || !row.missingEvidence.includes("report"))) throw new Error(`${scenario.name} handoff lost receiver receipts or missing evidence`);
    const alternatives = JSON.parse(runPm(scenario, scenarioRoot, ["--json", "brief", "alternatives", fixtureId, packet.id]).stdout) as DecisionAlternativesDigest;
    if (alternatives.alternatives.length !== 2 || alternatives.estimatedTokenCeiling > 4000 || alternatives.alternatives.some(row => row.statements.length < 2 || row.statements.some(statement => !statement.source.startsWith(`${row.id}#/`)))) throw new Error(`${scenario.name} alternatives lost independent cited records or exceeded the budget`);
    for (const audience of ["internal", "external", "public"]) {
      const disclosed = runPm(scenario, scenarioRoot, ["--json", "brief", "disclose", "--audience", audience]);
      const output = JSON.parse(disclosed.stdout) as DisclosureResult;
      if (output.profile !== audience || !output.brief || output.estimatedTokenCeiling > 8000 || disclosed.stderr !== "" || !disclosed.stdout.includes(fixtureTitle)) throw new Error(`${scenario.name} disclosure lost its audience, fixture or budget`);
    }
    const preview = JSON.parse(runPm(scenario, scenarioRoot, ["--json", "brief", "disclose", "--audience", "public", "--dry-run"]).stdout) as DisclosureResult;
    if (!preview.dryRun || preview.brief !== undefined || JSON.stringify(preview).includes(fixtureTitle)) throw new Error(`${scenario.name} disclosure dry run returned source values`);
    receipts.push({
      scenario: scenario.name,
      host_version: scenario.hostVersion,
      stdout_bytes: Buffer.byteLength(brief.stdout),
      stderr_bytes: Buffer.byteLength(brief.stderr),
      fixture_present: true,
      bounded_estimate: boundedEstimate,
      cannot_fit_exit_code: 2,
      handoff_receivers: 2,
      handoff_missing_evidence: true,
      decision_alternatives: 2,
      disclosure_profiles: 3,
      action_prerequisites: true,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
