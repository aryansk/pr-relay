import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_QUEUE_RESPONSE_BYTES,
  QUEUE_URL,
  fetchQueuePayload,
  pollQueue,
  validateQueuePayload,
} from "../scripts/poll-queue.mjs";
import { sanitizeForComment } from "../scripts/relay.mjs";

const patch = [
  "diff --git a/src/example.txt b/src/example.txt",
  "index 3b18e51..d4e1f2a 100644",
  "--- a/src/example.txt",
  "+++ b/src/example.txt",
  "@@ -1 +1 @@",
  "-old value",
  "+new value",
].join("\n");

function relayJob(overrides = {}) {
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

function queuedJob(overrides = {}) {
  const job = relayJob(overrides.job ?? {});
  const issueNumber = job.upstreamIssue ?? 1985;
  return {
    id: overrides.id ?? `queue-${issueNumber}`,
    title: overrides.title ?? `[pr-relay] ${job.upstream} #${issueNumber}`,
    body: overrides.body ?? JSON.stringify(job),
  };
}

function queuePayload(jobs) {
  return { version: 1, jobs };
}

function jsonResponse(value, status = 200, headers = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fetchResult(value, status = 200, headers = {}) {
  return async () => jsonResponse(value, status, headers);
}

class FakeGithubClient {
  constructor(issues = []) {
    this.issues = [...issues];
    this.created = [];
    this.listCalls = 0;
  }

  async listIssues(repository) {
    assert.equal(repository, "aryansk/pr-relay");
    this.listCalls += 1;
    return this.issues;
  }

  async createIssue(repository, payload) {
    assert.equal(repository, "aryansk/pr-relay");
    this.created.push(payload);
    this.issues.push({ title: payload.title, body: payload.body });
    return { html_url: `https://github.com/aryansk/pr-relay/issues/${this.created.length}` };
  }
}

async function assertRejectedWithoutWrites(payload, fetchImpl, expected) {
  const client = new FakeGithubClient();
  await assert.rejects(
    pollQueue({ enabled: true, client, fetchImpl: fetchImpl ?? fetchResult(payload) }),
    expected,
  );
  assert.equal(client.created.length, 0);
  assert.equal(client.listCalls, 0);
}

test("valid queue job creates exactly one issue with the exact supplied body", async () => {
  const queued = queuedJob({ id: "job-1" });
  const client = new FakeGithubClient();
  const result = await pollQueue({ enabled: true, client, fetchImpl: fetchResult(queuePayload([queued])) });

  assert.deepEqual(result.created, ["job-1"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].title, queued.title);
  assert.equal(client.created[0].body, queued.body);
});

test("repeated polling of the same payload creates no duplicate issue", async () => {
  const queued = queuedJob({ id: "repeat-1" });
  const client = new FakeGithubClient();
  const fetchImpl = fetchResult(queuePayload([queued]));

  const first = await pollQueue({ enabled: true, client, fetchImpl });
  const second = await pollQueue({ enabled: true, client, fetchImpl });

  assert.deepEqual(first.created, ["repeat-1"]);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.skipped, ["repeat-1"]);
  assert.equal(client.created.length, 1);
});

test("accepts a batch of five valid jobs", async () => {
  const jobs = Array.from({ length: 5 }, (_, index) => queuedJob({
    id: `batch-${index + 1}`,
    job: {
      branch: `fix/batch-${index + 1}`,
      upstreamIssue: 2000 + index,
      prBody: `Fixes #${2000 + index}`,
    },
  }));
  const client = new FakeGithubClient();
  const result = await pollQueue({ enabled: true, client, fetchImpl: fetchResult(queuePayload(jobs)) });

  assert.equal(result.created.length, 5);
  assert.equal(client.created.length, 5);
});

test("rejects more than five jobs before reading GitHub issues", async () => {
  const jobs = Array.from({ length: 6 }, (_, index) => queuedJob({
    id: `too-many-${index + 1}`,
    job: { branch: `fix/too-many-${index + 1}`, upstreamIssue: 2100 + index },
  }));
  await assertRejectedWithoutWrites(queuePayload(jobs), undefined, /at most 5/);
});

test("rejects invalid relay JSON before any write", async () => {
  await assertRejectedWithoutWrites(
    queuePayload([queuedJob({ id: "bad-json", body: "{not-json" })]),
    undefined,
    /JSON/,
  );
});

test("rejects invalid titles before any write", async () => {
  await assertRejectedWithoutWrites(
    queuePayload([queuedJob({ id: "bad-title", title: "not a relay title" })]),
    undefined,
    /title/,
  );
});

test("rejects a title and upstream mismatch before any write", async () => {
  await assertRejectedWithoutWrites(
    queuePayload([queuedJob({ id: "mismatch", title: "[pr-relay] other/project #1985" })]),
    undefined,
    /do not match/,
  );
});

test("skips a branch already present in a relay issue body", async () => {
  const queued = queuedJob({ id: "existing-branch" });
  const client = new FakeGithubClient([{ title: queued.title, body: queued.body }]);
  const result = await pollQueue({ enabled: true, client, fetchImpl: fetchResult(queuePayload([queued])) });

  assert.deepEqual(result.created, []);
  assert.deepEqual(result.skipped, ["existing-branch"]);
  assert.equal(client.created.length, 0);
});

test("rejects an oversized queue response before any write", async () => {
  const client = new FakeGithubClient();
  await assert.rejects(
    pollQueue({
      enabled: true,
      client,
      fetchImpl: fetchResult("x".repeat(MAX_QUEUE_RESPONSE_BYTES + 1)),
    }),
    /exceeds/,
  );
  assert.equal(client.created.length, 0);
  assert.equal(client.listCalls, 0);
});

test("rejects unexpected queue fields before any write", async () => {
  await assertRejectedWithoutWrites({ version: 1, jobs: [], extra: true }, undefined, /unexpected or missing/);
});

test("HTTP and network failures perform no GitHub writes", async () => {
  const client = new FakeGithubClient();
  await assert.rejects(
    pollQueue({ enabled: true, client, fetchImpl: fetchResult({ error: "unavailable" }, 503) }),
    /HTTP 503/,
  );
  await assert.rejects(
    pollQueue({ enabled: true, client, fetchImpl: async () => { throw new Error("offline"); } }),
    /queue request failed: offline/,
  );
  assert.equal(client.created.length, 0);
  assert.equal(client.listCalls, 0);
});

test("malformed queue and unsafe redirects perform no writes", async () => {
  await assertRejectedWithoutWrites("not-json", undefined, /not valid JSON/);
  await assertRejectedWithoutWrites(
    queuePayload([queuedJob({ id: "redirect" })]),
    async () => new Response(null, { status: 302, headers: { location: "https://evil.example/jobs" } }),
    /unexpected host/,
  );
  await assert.rejects(
    fetchQueuePayload({ queueUrl: QUEUE_URL.replace("https://", "http://"), fetchImpl: () => { throw new Error("must not fetch"); } }),
    /HTTPS/,
  );
});

test("disabled polling performs no fetch or GitHub write", async () => {
  const client = new FakeGithubClient();
  const result = await pollQueue({
    enabled: false,
    client,
    fetchImpl: () => { throw new Error("must not fetch"); },
  });

  assert.equal(result.state, "disabled");
  assert.equal(client.created.length, 0);
  assert.equal(client.listCalls, 0);
});

test("token-like values are redacted from queue diagnostics", async () => {
  const secret = "github_pat_queue_test_secret_123";
  const previous = process.env.PR_RELAY_TOKEN;
  process.env.PR_RELAY_TOKEN = secret;
  try {
    await assert.rejects(
      fetchQueuePayload({
        fetchImpl: async () => { throw new Error(`Authorization: Bearer ${secret}`); },
      }),
      (error) => {
        assert.equal(error.message.includes(secret), false);
        assert.equal(sanitizeForComment(error.message).includes(secret), false);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PR_RELAY_TOKEN;
    else process.env.PR_RELAY_TOKEN = previous;
  }
});

test("rejects duplicate queue ids", () => {
  const duplicate = queuedJob({ id: "same-id" });
  assert.throws(() => validateQueuePayload(queuePayload([duplicate, duplicate])), /duplicate job id/);
});
