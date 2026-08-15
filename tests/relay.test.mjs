import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PATCH_BYTES,
  RelayError,
  deriveJobId,
  findProcessedResult,
  parseIssueBody,
  parsePatchPaths,
  parseRelayTitle,
  redactSecrets,
  sanitizeForComment,
  validateBranchName,
  validateChangedPaths,
  validateJob,
  validatePatchText,
} from "../scripts/relay.mjs";

const patch = [
  "diff --git a/src/example.txt b/src/example.txt",
  "index 3b18e51..d4e1f2a 100644",
  "--- a/src/example.txt",
  "+++ b/src/example.txt",
  "@@ -1 +1 @@",
  "-old value",
  "+new value",
].join("\n");

function validJob(overrides = {}) {
  return {
    version: 1,
    upstream: "octo/project",
    fork: "aryansk/project",
    base: "main",
    branch: "fix/1985-safe-change",
    commitMessage: "fix: make the change",
    prTitle: "fix: make the change",
    prBody: "Fixes #1985",
    patch,
    draft: true,
    upstreamIssue: 1985,
    ...overrides,
  };
}

function assertRelayError(callback, expectedText) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof RelayError, `expected RelayError, got ${error}`);
    assert.match(error.message, expectedText);
    return true;
  });
}

test("accepts a strict data-only job and parses its unified diff paths", () => {
  const result = validateJob(validJob());
  assert.equal(result.version, 1);
  assert.deepEqual(parsePatchPaths(result.patch), ["src/example.txt"]);
});

test("rejects malformed repository names and non-aryansk forks", () => {
  for (const upstream of ["https://github.com/octo/project", "octo/project/extra", "/project", "octo/"]) {
    assertRelayError(() => validateJob(validJob({ upstream })), /owner\/repository|invalid/);
  }
  assertRelayError(() => validateJob(validJob({ fork: "someone/project" })), /fork owner must be exactly aryansk/);
  assertRelayError(() => validateJob(validJob({ fork: "aryansk/../project" })), /owner\/repository|invalid/);
});

test("rejects branch command injection, dangerous refs, traversal, and newline injection", () => {
  for (const branch of [
    "fix/x;touch-/tmp/pwned",
    "fix/x$(id)",
    "fix/x\nwhoami",
    "../main",
    "refs/heads/main",
    "fix//double-slash",
    "fix/..",
    "main",
    "fix/name.lock",
    "fix/emoji-🚀",
  ]) {
    assertRelayError(() => validateBranchName(branch), /branch/);
  }
  assertRelayError(() => validateJob(validJob({ prTitle: "title\nX-Injected: yes" })), /prTitle/);
  assertRelayError(() => validateJob(validJob({ commitMessage: "fix\u0000: bad" })), /commitMessage/);
});

test("keeps shell metacharacters in commit data without treating them as commands", () => {
  const result = validateJob(validJob({
    commitMessage: "fix: preserve $HOME; echo do-not-run",
    prTitle: "fix: preserve ; $(not-a-command)",
  }));
  assert.equal(result.commitMessage, "fix: preserve $HOME; echo do-not-run");
  assert.equal(result.prTitle, "fix: preserve ; $(not-a-command)");
});

test("rejects empty, oversized, binary, and malformed unified patches", () => {
  assertRelayError(() => validateJob(validJob({ patch: "" })), /patch/);
  assertRelayError(() => validatePatchText("x".repeat(MAX_PATCH_BYTES + 1)), /524288|limit/);
  assertRelayError(() => validatePatchText("GIT binary patch\nanything"), /binary/);
  assertRelayError(() => validatePatchText("diff --git a/a b/a\n--- a/a\n+++ b/a\n-old\n+new"), /unified git diff/);
});

test("rejects path traversal and paths outside the repository", () => {
  const traversal = [
    "diff --git a/../../etc/passwd b/../../etc/passwd",
    "--- a/../../etc/passwd",
    "+++ b/../../etc/passwd",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assertRelayError(() => validatePatchText(traversal), /traversal/);

  const absolute = [
    "diff --git a/a b/a",
    "--- /etc/passwd",
    "+++ b/a",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assertRelayError(() => validatePatchText(absolute), /malformed|absolute/);
});

test("blocks workflow, CI, credential, and automation paths by default", () => {
  for (const value of [
    ".github/workflows/pwn.yml",
    ".github/actions/run/action.yml",
    ".env.production",
    "config/service-account.json",
    "certs/signing.pem",
    "Makefile",
    ".circleci/config.yml",
  ]) {
    assertRelayError(() => validateChangedPaths([value]), /blocked by the default sensitive-path policy/);
  }
  assert.equal(validateChangedPaths([".github/workflows/reviewed.yml"], { allowlist: [".github/workflows/reviewed.yml"] }), true);
  assert.equal(validateChangedPaths([".github/workflows/reviewed.yml"], { allowlist: [".github/workflows/**"] }), true);
});

test("rejects symlink and Git metadata paths through shared path validation", () => {
  assertRelayError(() => validateChangedPaths([".git/config"]), /Git metadata|path traversal/);
  assertRelayError(() => validateChangedPaths(["a/../b"]), /traversal/);
});

test("parses only the deterministic relay title and JSON body shapes", () => {
  assert.deepEqual(parseRelayTitle("[pr-relay] octo/project #1985"), { repository: "octo/project", issueNumber: 1985 });
  assertRelayError(() => parseRelayTitle("[pr-relay] octo/project"), /title/);
  assertRelayError(() => parseRelayTitle("[pr-relay] octo/project #1000000000"), /title/);
  assert.deepEqual(parseIssueBody(JSON.stringify(validJob())), validJob());
  assert.deepEqual(parseIssueBody(`\`\`\`json\n${JSON.stringify(validJob())}\n\`\`\``), validJob());
  assertRelayError(() => parseIssueBody("explanation\n{"), /one JSON object/);
});

test("rejects bidi/control Unicode while allowing ordinary Unicode commit text", () => {
  assert.equal(validateJob(validJob({ commitMessage: "fix: café" })).commitMessage, "fix: café");
  assertRelayError(() => validateJob(validJob({ commitMessage: "fix: hidden\u202Etext" })), /control character|Unicode/);
});

test("derives one stable job id and detects prior terminal results", () => {
  const first = deriveJobId("aryansk/pr-relay", 42);
  assert.equal(first, deriveJobId("aryansk/pr-relay", 42));
  assert.notEqual(first, deriveJobId("aryansk/pr-relay", 43));
  const comments = [
    { body: `FAILED\n${"<!-- pr-relay-result job="}${first} state=failed -->` },
    { body: `SUCCESS\n<!-- pr-relay-result job=${first} state=success -->`, html_url: "https://github.com/aryansk/pr-relay/issues/42#issuecomment-2" },
  ];
  const result = findProcessedResult(comments, first);
  assert.equal(result.state, "success");
  assert.equal(result.url, "https://github.com/aryansk/pr-relay/issues/42#issuecomment-2");
  assert.equal(findProcessedResult(comments, deriveJobId("aryansk/pr-relay", 99)), null);
});

test("redacts credentials and GitHub workflow command syntax from diagnostic text", () => {
  const secret = "github_pat_example_secret_123";
  assert.equal(redactSecrets(`Authorization: Bearer ${secret}`, secret).includes(secret), false);
  assert.equal(sanitizeForComment("::set-output name=x::github_pat_example_secret_123", 500).includes("::"), false);
});
