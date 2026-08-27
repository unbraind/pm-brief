import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
}

/** Concise receipt emitted for each successfully loaded packed extension. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly fixture_present: true;
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
function run(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: cleanEnvironment,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
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
function runPm(scenario: AcceptanceScenario, cwd: string, args: string[]): SpawnSyncReturns<string> {
  // --silent keeps npm's own runner off stderr. From npm 11 the runner writes a
  // progress notice there, which says nothing about the package; silencing the
  // runner is better than filtering its output afterwards, because any filter
  // wide enough to catch the notice is also wide enough to discard a diagnostic
  // the installed host or extension printed -- exactly what this gate exists to
  // catch.
  return scenario.manager === "npm"
    ? run(npxCommand, ["--no-install", "--silent", "pm", ...args], cwd)
    : run(bunxCommand, ["--no-install", "pm", ...args], cwd);
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
  ];
  const receipts: AcceptanceReceipt[] = [];

  for (const scenario of scenarios) {
    const scenarioRoot = join(temporaryRoot, scenario.name);
    mkdirSync(scenarioRoot);
    if (scenario.manager === "npm") {
      run(npmCommand, ["init", "-y"], scenarioRoot);
      run(npmCommand, ["install", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
    } else {
      run(bunCommand, ["init", "-y"], scenarioRoot);
      run(bunCommand, ["add", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
    }

    runPm(scenario, scenarioRoot, ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"]);
    const fixtureTitle = `Validate packed pm-brief ${scenario.name}`;
    runPm(scenario, scenarioRoot, [
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
    receipts.push({
      scenario: scenario.name,
      host_version: scenario.hostVersion,
      stdout_bytes: Buffer.byteLength(brief.stdout),
      stderr_bytes: Buffer.byteLength(brief.stderr),
      fixture_present: true,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
