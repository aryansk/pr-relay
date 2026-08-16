import test from "node:test";
import assert from "node:assert/strict";

import {
  AIRTABLE_API_URL,
  AIRTABLE_FIELDS,
  MAX_QUEUE_JOBS,
  pollQueue,
  sanitizeQueueDiagnostic,
} from "../scripts/poll-queue.mjs";

const AIRTABLE_TOKEN = "airtable_test_token_should_never_be_logged";
const GITHUB_TOKEN = "github_pat_queue_test_secret_123";

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

function recordId(number) {
  return `rec${String(number).padStart(14, "0")}`;
}

function airtableRecord(overrides = {}) {
  const job = relayJob(overrides.job ?? {});
  return {
    id: overrides.recordId ?? recordId(overrides.recordNumber ?? 1),
    createdTime: overrides.createdTime ?? "2026-08-16T00:00:00.000Z",
    fields: {
      [AIRTABLE_FIELDS.jobId]: overrides.id ?? "job-1",
      [AIRTABLE_FIELDS.title]: overrides.title ?? `[pr-relay] ${job.upstream} #${job.upstreamIssue}`,
      [AIRTABLE_FIELDS.body]: overrides.body ?? JSON.stringify(job),
      [AIRTABLE_FIELDS.branch]: overrides.branch ?? job.branch,
      [AIRTABLE_FIELDS.status]: overrides.status ?? "Pending",
      [AIRTABLE_FIELDS.batchId]: overrides.batchId ?? "batch-test",
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function airtableHarness(records, { readError, statusError } = {}) {
  const calls = [];
  const statuses = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
    assert.equal(options.headers.authorization, `Bearer ${AIRTABLE_TOKEN}`);
    if (options.method === "GET") {
      if (readError) throw new Error(`Authorization: Bearer ${AIRTABLE_TOKEN}`);
      return jsonResponse({ records });
    }
    assert.equal(options.method, "PATCH");
    const recordIdValue = String(url).split("/").pop();
    const payload = JSON.parse(options.body);
    const status = payload.fields[AIRTABLE_FIELDS.status];
    statuses.push({ recordId: recordIdValue, status });
    if (statusError) return jsonResponse({ error: "temporary" }, 503);
    return jsonResponse({ id: recordIdValue, fields: payload.fields });
  };
  return { calls, statuses, fetchImpl };
}

class FakeGithubClient {
  constructor(issues = [], { createError = null } = {}) {
    this.issues = [...issues];
    this.created = [];
    this.listCalls = 0;
    this.createError = createError;
  }

  async listIssues(repository) {
    assert.equal(repository, "aryansk/pr-relay");
    this.listCalls += 1;
    return this.issues;
  }

  async createIssue(repository, payload) {
    assert.equal(repository, "aryansk/pr-relay");
    if (this.createError) throw this.createError;
    this.created.push(payload);
    this.issues.push({ title: payload.title, body: payload.body });
    return { html_url: `https://github.com/aryansk/pr-relay/issues/${this.created.length}` };
  }
}

function runPoll(records, { client = new FakeGithubClient(), readError = false, statusError = false } = {}) {
  const airtable = airtableHarness(records, { readError, statusError });
  return {
    airtable,
    client,
    promise: pollQueue({
      enabled: true,
      airtableToken: AIRTABLE_TOKEN,
      githubToken: GITHUB_TOKEN,
      client,
      fetchImpl: airtable.fetchImpl,
    }),
  };
}

test("empty Airtable queue performs no GitHub writes", async () => {
  const { promise, airtable, client } = runPoll([]);
  const result = await promise;

  assert.deepEqual(result, { state: "completed", created: [], skipped: [], failed: [], total: 0 });
  assert.equal(client.listCalls, 0);
  assert.equal(client.created.length, 0);
  assert.equal(airtable.statuses.length, 0);
  assert.equal(airtable.calls[0].url.startsWith(AIRTABLE_API_URL), true);
});

test("one valid Pending job creates exactly one issue and becomes Consumed", async () => {
  const queued = airtableRecord({ id: "job-1" });
  const { promise, airtable, client } = runPoll([queued]);
  const result = await promise;

  assert.deepEqual(result.created, ["job-1"]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.failed, []);
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].title, queued.fields[AIRTABLE_FIELDS.title]);
  assert.equal(client.created[0].body, queued.fields[AIRTABLE_FIELDS.body]);
  assert.deepEqual(airtable.statuses, [{ recordId: queued.id, status: "Consumed" }]);
});

test("five valid Pending jobs are processed", async () => {
  const records = Array.from({ length: 5 }, (_, index) => airtableRecord({
    recordNumber: index + 1,
    id: `job-${index + 1}`,
    job: {
      branch: `fix/batch-${index + 1}`,
      upstreamIssue: 2000 + index,
      prBody: `Fixes #${2000 + index}`,
    },
    createdTime: `2026-08-16T00:0${index}:00.000Z`,
  }));
  const { promise, client, airtable } = runPoll(records);
  const result = await promise;

  assert.deepEqual(result.created, ["job-1", "job-2", "job-3", "job-4", "job-5"]);
  assert.equal(client.created.length, 5);
  assert.equal(airtable.statuses.length, 5);
});

test("more than five Pending jobs processes the oldest five", async () => {
  const records = Array.from({ length: 7 }, (_, index) => airtableRecord({
    recordNumber: index + 1,
    id: `job-${index + 1}`,
    job: {
      branch: `fix/oldest-${index + 1}`,
      upstreamIssue: 2100 + index,
      prBody: `Fixes #${2100 + index}`,
    },
    createdTime: `2026-08-16T00:0${index}:00.000Z`,
  })).reverse();
  const { promise, client, airtable } = runPoll(records);
  const result = await promise;

  assert.equal(MAX_QUEUE_JOBS, 5);
  assert.deepEqual(result.created, ["job-1", "job-2", "job-3", "job-4", "job-5"]);
  assert.deepEqual(airtable.statuses.map((item) => item.recordId), records.slice(2).reverse().map((item) => item.id));
  assert.equal(client.created.length, 5);
});

test("Consumed and Failed rows are ignored", async () => {
  const pending = airtableRecord({ recordNumber: 1, id: "pending", job: { branch: "fix/pending" } });
  const consumed = airtableRecord({ recordNumber: 2, id: "consumed", status: "Consumed", job: { branch: "fix/consumed" } });
  const failed = airtableRecord({ recordNumber: 3, id: "failed", status: "Failed", job: { branch: "fix/failed" } });
  const { promise, client, airtable } = runPoll([consumed, failed, pending]);
  const result = await promise;

  assert.deepEqual(result.created, ["pending"]);
  assert.deepEqual(airtable.statuses, [{ recordId: pending.id, status: "Consumed" }]);
  assert.equal(client.created.length, 1);
});

test("a malformed Pending row becomes Failed without creating an issue", async () => {
  const malformed = airtableRecord({ recordNumber: 1, id: "malformed", body: "{not-json" });
  const { promise, client, airtable } = runPoll([malformed]);
  const result = await promise;

  assert.deepEqual(result, { state: "completed", created: [], skipped: [], failed: [malformed.id], total: 1 });
  assert.equal(client.listCalls, 0);
  assert.equal(client.created.length, 0);
  assert.deepEqual(airtable.statuses, [{ recordId: malformed.id, status: "Failed" }]);
});

test("a duplicate validated branch becomes Consumed without creating an issue", async () => {
  const duplicate = airtableRecord({ recordNumber: 1, id: "duplicate", job: { branch: "fix/existing-2538" } });
  const existingIssue = {
    title: duplicate.fields[AIRTABLE_FIELDS.title],
    body: duplicate.fields[AIRTABLE_FIELDS.body],
  };
  const client = new FakeGithubClient([existingIssue]);
  const { promise, airtable } = runPoll([duplicate], { client });
  const result = await promise;

  assert.deepEqual(result.created, []);
  assert.deepEqual(result.skipped, ["duplicate"]);
  assert.equal(client.created.length, 0);
  assert.deepEqual(airtable.statuses, [{ recordId: duplicate.id, status: "Consumed" }]);
});

test("successful GitHub issue creation is followed by Consumed", async () => {
  const record = airtableRecord({ recordNumber: 1, id: "created" });
  const { promise, airtable, client } = runPoll([record]);
  await promise;

  assert.equal(client.created.length, 1);
  assert.deepEqual(airtable.statuses, [{ recordId: record.id, status: "Consumed" }]);
});

test("GitHub issue creation failure leaves the Airtable row Pending", async () => {
  const record = airtableRecord({ recordNumber: 1, id: "github-failure" });
  const client = new FakeGithubClient([], { createError: new Error("GitHub unavailable") });
  const { promise, airtable } = runPoll([record], { client });

  await assert.rejects(promise, (error) => error.stage === "github-write");
  assert.equal(client.created.length, 0);
  assert.deepEqual(airtable.statuses, []);
});

test("Airtable read failure performs no GitHub writes and keeps the token out of errors", async () => {
  const client = new FakeGithubClient();
  const { promise, airtable } = runPoll([], { client, readError: true });

  await assert.rejects(promise, (error) => {
    assert.equal(error.message.includes(AIRTABLE_TOKEN), false);
    return error.stage === "airtable-read";
  });
  assert.equal(client.listCalls, 0);
  assert.equal(client.created.length, 0);
  assert.equal(airtable.statuses.length, 0);
});

test("Airtable status-update failure fails safely after the write attempt", async () => {
  const record = airtableRecord({ recordNumber: 1, id: "status-failure" });
  const { promise, airtable, client } = runPoll([record], { statusError: true });

  await assert.rejects(promise, (error) => error.stage === "airtable-write");
  assert.equal(client.created.length, 1);
  assert.deepEqual(airtable.statuses, [{ recordId: record.id, status: "Consumed" }]);
});

test("disabled polling performs no Airtable or GitHub writes", async () => {
  const client = new FakeGithubClient();
  let calls = 0;
  const result = await pollQueue({
    enabled: false,
    client,
    fetchImpl: () => { calls += 1; throw new Error("must not fetch"); },
  });

  assert.equal(result.state, "disabled");
  assert.equal(calls, 0);
  assert.equal(client.listCalls, 0);
  assert.equal(client.created.length, 0);
});

test("Airtable and GitHub token-like values never appear in diagnostics", () => {
  const diagnostic = sanitizeQueueDiagnostic(`Authorization: Bearer ${AIRTABLE_TOKEN}; x-access-token=${GITHUB_TOKEN}`, {
    airtableToken: AIRTABLE_TOKEN,
    githubToken: GITHUB_TOKEN,
  });
  assert.equal(diagnostic.includes(AIRTABLE_TOKEN), false);
  assert.equal(diagnostic.includes(GITHUB_TOKEN), false);
});
