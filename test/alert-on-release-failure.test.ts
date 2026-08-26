/**
 * Hermetic tests for scripts/alert-on-release-failure.sh, the script the
 * `alert-on-release-failure` job of .github/workflows/release.yml executes.
 *
 * The workflow cannot be exercised end to end (a real run merges a release
 * commit into protected main and burns a version number before it can ever
 * reach the failing publish step), so these tests stub `gh` on PATH and
 * assert the three behaviours the inline script previously had no recorded
 * evidence for:
 *
 * 1. no existing tracking issue  -> exactly one `gh issue create` with the
 *    stable title, the `release-failure` label, and the run URL / commit /
 *    date in the body;
 * 2. an existing open issue      -> a comment on THAT number and no second
 *    create (cross-run deduplication);
 * 3. every mutation failing      -> exit 0 (non-blocking) plus a `::warning::`
 *    annotation;
 * 4. the dedup lookup failing    -> no create or comment, avoiding duplicates.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/** The exact bytes the release workflow's alert job executes. */
const SCRIPT = new URL("../scripts/alert-on-release-failure.sh", import.meta.url);

/** The workflow whose alert job must wire up the checked-in script. */
const WORKFLOW_YAML = new URL("../.github/workflows/release.yml", import.meta.url).pathname;

const STABLE_TITLE = "Daily Release workflow is failing";
const MARKER_LABEL = "release-failure";
const REPO = "unbraind/pm-brief";
const RUN_ID = "424242";
const COMMIT_SHA = "abc123def4567890abcdef1234567890abcdef12";

interface AlertRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Write a fake `gh` whose runtime behaviour is selected by the injected
 * `ALERT_GH_MODE` environment variable: `existing` answers the dedup lookup
 * with issue #77, `fail` fails every call, `list-fail` fails only the dedup
 * lookup, and the default succeeds while producing no lookup result.
 */
function makeStubGh(binDir: string): void {
  const stub = `#!/usr/bin/env bash
{
  echo "CALL: $*"
  prev=""
  for arg in "$@"; do
    if [[ "$prev" == "--body-file" && -f "$arg" ]]; then
      echo "BODY-BEGIN"
      cat "$arg"
      echo "BODY-END"
    fi
    prev="$arg"
  done
} >> "\${ALERT_GH_LOG}"
if [[ "\${ALERT_GH_MODE}" == "fail" && "\${1:-}" == "issue" && "\${2:-}" != "list" ]]; then
  echo "stub gh: simulated failure" >&2
  exit 1
fi
if [[ "\${ALERT_GH_MODE}" == "list-fail" && "\${1:-}" == "issue" && "\${2:-}" == "list" ]]; then
  echo "stub gh: simulated lookup failure" >&2
  exit 1
fi
if [[ "\${1:-}" == "issue" && "\${2:-}" == "list" && "\${ALERT_GH_MODE}" == "existing" ]]; then
  echo 77
fi
exit 0
`;
  const ghPath = path.join(binDir, "gh");
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);
}

function runAlertScript(mode: "fresh" | "existing" | "fail" | "list-fail"): {
  run: AlertRun;
  log: string;
  cleanup: () => void;
} {
  const workspace = mkdtempSync(path.join(tmpdir(), "alert-script-test-"));
  const binDir = path.join(workspace, "bin");
  mkdirSync(binDir);
  const logPath = path.join(workspace, "gh-calls.log");
  makeStubGh(binDir);
  const run = spawnSync("bash", [SCRIPT.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      ALERT_GH_LOG: logPath,
      ALERT_GH_MODE: mode,
      GITHUB_REPOSITORY: REPO,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_SHA: COMMIT_SHA,
      GH_TOKEN: "stub-token",
    },
  });
  return {
    run: { status: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" },
    log: logPath,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

test("hermetic alert script test: creates the deduplicated release-failure issue with run URL, commit, and date when no open issue exists", () => {
  const { run, log, cleanup } = runAlertScript("fresh");
  try {
    assert.equal(run.status, 0, `script failed:\n${run.stdout}\n${run.stderr}`);
    const calls = readLog(log);
    // The dedup lookup ran against the marker label + stable title.
    assert.match(calls, new RegExp(`CALL: issue list .*--label ${MARKER_LABEL}`));
    assert.match(calls, new RegExp(`CALL: issue list .*${STABLE_TITLE} in:title`));
    // Exactly one create, with the stable title and marker label.
    assert.equal(countCalls(calls, "issue create"), 1);
    assert.match(calls, new RegExp(`CALL: issue create .*--title ${STABLE_TITLE}`));
    assert.match(calls, new RegExp(`CALL: issue create .*--label ${MARKER_LABEL}`));
    // The created body carries the failing-job context.
    const body = bodyOfLastCall(calls);
    assert.match(body, /- Failing job: `release`/);
    assert.match(body, new RegExp(`- Run URL: https://github.com/${REPO}/actions/runs/${RUN_ID}`));
    assert.match(body, new RegExp(`- Commit: ${COMMIT_SHA}`));
    assert.match(body, /- Date \(UTC\): \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    // No warning path was taken on success.
    assert.ok(!run.stdout.includes("::warning::"), "unexpected ::warning:: on the happy path");
  } finally {
    cleanup();
  }
});

test("hermetic alert script test: comments on the existing open release-failure issue instead of creating a second one", () => {
  const { run, log, cleanup } = runAlertScript("existing");
  try {
    assert.equal(run.status, 0, `script failed:\n${run.stdout}\n${run.stderr}`);
    const calls = readLog(log);
    // Cross-run deduplication: comment on the found number, never create.
    assert.equal(countCalls(calls, "issue comment"), 1);
    assert.match(calls, /^CALL: issue comment 77 --repo /m);
    assert.equal(countCalls(calls, "issue create"), 0, "must not open a duplicate tracking issue");
    const body = bodyOfLastCall(calls);
    assert.match(body, new RegExp(`- Run URL: https://github.com/${REPO}/actions/runs/${RUN_ID}`));
  } finally {
    cleanup();
  }
});

test("hermetic alert script test: stays non-blocking (exit 0) and emits ::warning:: when issue mutation fails", () => {
  const { run, cleanup } = runAlertScript("fail");
  try {
    // Alerting must never mask the original release failure's exit code.
    assert.equal(run.status, 0, `script must stay non-blocking, got ${run.status}`);
    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(
      output,
      /::warning::Could not open or update the release-failure tracking issue/,
    );
  } finally {
    cleanup();
  }
});

test("hermetic alert script test: does not mutate when the dedup lookup fails", () => {
  const { run, log, cleanup } = runAlertScript("list-fail");
  try {
    assert.equal(run.status, 0, `script must stay non-blocking, got ${run.status}`);
    const calls = readLog(log);
    assert.equal(countCalls(calls, "issue create"), 0, "must not risk a duplicate issue");
    assert.equal(countCalls(calls, "issue comment"), 0, "must not mutate an unknown issue");
    assert.equal(countCalls(calls, "label create"), 0, "must not mutate labels after a failed lookup");
    assert.match(`${run.stdout}\n${run.stderr}`, /::warning::.*duplicate/);
  } finally {
    cleanup();
  }
});

test("release.yml wiring: the alert job checks out the repository and executes scripts/alert-on-release-failure.sh", () => {
  const yaml = readFileSync(WORKFLOW_YAML, "utf8");
  const jobStart = yaml.indexOf("alert-on-release-failure:");
  assert.notEqual(jobStart, -1, "alert-on-release-failure job missing from release.yml");
  const job = yaml.slice(jobStart);
  assert.match(job, /^\s+if: failure\(\) && github\.event_name == 'schedule'$/m);
  assert.match(job, /^\s+group: release-failure-alert-\$\{\{ github\.repository \}\}$/m);
  assert.match(job, /^\s+cancel-in-progress: false$/m);
  assert.match(job, /^\s+uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7$/m);
  assert.match(job, /^\s+ref: \$\{\{ github\.event\.repository\.default_branch \}\}$/m);
  assert.match(job, /^\s+persist-credentials: false$/m);
  assert.match(job, /^\s+run: bash scripts\/alert-on-release-failure\.sh$/m);
});

/** Read the stub call log written by {@link makeStubGh}. */
function readLog(logPath: string): string {
  return readFileSync(logPath, "utf8");
}

/** Count logged invocations of a `gh` subcommand pair such as "issue create". */
function countCalls(calls: string, command: string): number {
  return calls.split("\n").filter((line) => line.startsWith(`CALL: ${command} `)).length;
}

/** Extract the BODY-BEGIN..BODY-END payload of the last logged call. */
function bodyOfLastCall(calls: string): string {
  const match = calls.match(/BODY-BEGIN\n([\s\S]*?)BODY-END/g);
  assert.ok(match, "no --body-file payload was logged");
  const last = match[match.length - 1];
  return last.replace("BODY-BEGIN\n", "").replace(/\nBODY-END$/, "");
}
