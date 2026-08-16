import {
  GithubClient,
  MAX_ISSUE_BODY_BYTES,
  RELAY_REPOSITORY,
  RelayError,
  parseIssueBody,
  parseRelayTitle,
  redactSecrets,
  sanitizeForComment,
  validateJob,
} from "./relay.mjs";

export const AIRTABLE_BASE_ID = "appppBJ8XPrwVIi3L";
export const AIRTABLE_TABLE_ID = "tblntNqkRKxAiP0G8";
export const AIRTABLE_API_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`;
export const AIRTABLE_TIMEOUT_MS = 10 * 1000;
export const MAX_AIRTABLE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_AIRTABLE_RECORDS = 500;
export const AIRTABLE_PAGE_SIZE = 100;
export const MAX_QUEUE_JOBS = 5;
export const MAX_QUEUE_ID_BYTES = 128;

export const AIRTABLE_FIELDS = Object.freeze({
  jobId: "fld2cEL0l1LtDMxqk",
  title: "fldopC8sU2uvu2Mqj",
  body: "fldmdxkoS9TCrCCC2",
  branch: "fldRVu17rw957qtqR",
  status: "fldbo5Rk4VUs9zCET",
  batchId: "fldMkcGqGQmT2EZtJ",
});

const AIRTABLE_FIELD_NAMES = Object.freeze({
  [AIRTABLE_FIELDS.jobId]: "Job ID",
  [AIRTABLE_FIELDS.title]: "Title",
  [AIRTABLE_FIELDS.body]: "Body",
  [AIRTABLE_FIELDS.branch]: "Branch",
  [AIRTABLE_FIELDS.status]: "Status",
  [AIRTABLE_FIELDS.batchId]: "Batch ID",
});

const QUEUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AIRTABLE_RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const AIRTABLE_STATUSES = new Set(["Pending", "Consumed", "Failed"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function fieldValue(fields, fieldId) {
  if (!isPlainObject(fields)) return undefined;
  if (Object.prototype.hasOwnProperty.call(fields, fieldId)) return fields[fieldId];
  return fields[AIRTABLE_FIELD_NAMES[fieldId]];
}

function scalarString(value) {
  if (typeof value === "string") return value;
  if (isPlainObject(value) && typeof value.name === "string") return value.name;
  return null;
}

function safeErrorMessage(error, secrets = []) {
  let message = String(error?.message ?? error ?? "unknown error");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) message = message.split(secret).join("[redacted-token]");
  }
  return sanitizeForComment(message, 1_200);
}

export function sanitizeQueueDiagnostic(value, { airtableToken = process.env.AIRTABLE_TOKEN, githubToken = process.env.PR_RELAY_TOKEN } = {}) {
  let text = redactSecrets(String(value ?? ""), githubToken);
  text = redactSecrets(text, airtableToken);
  return sanitizeForComment(text, 1_500);
}

function queueError(stage, message) {
  return new RelayError(stage, sanitizeQueueDiagnostic(message));
}

function requireToken(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new RelayError("airtable-auth", "AIRTABLE_TOKEN is not configured");
  }
  return token;
}

function requireAirtableRecordId(recordId, index) {
  if (typeof recordId !== "string" || !AIRTABLE_RECORD_ID_RE.test(recordId)) {
    throw queueError("airtable-validation", `Airtable record ${index + 1} has an invalid record id`);
  }
  return recordId;
}

function headerValue(response, name) {
  return typeof response?.headers?.get === "function" ? response.headers.get(name) : null;
}

async function readBoundedResponseText(response, maxBytes) {
  const contentLength = headerValue(response, "content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw queueError("airtable-response", "Airtable response content length is invalid");
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      throw queueError("airtable-response", "Airtable response is too large");
    }
  }

  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw queueError("airtable-response", "Airtable response is too large");
        }
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  }

  if (typeof response?.text !== "function") throw queueError("airtable-response", "Airtable response body is unreadable");
  const text = await response.text();
  if (byteLength(text) > maxBytes) throw queueError("airtable-response", "Airtable response is too large");
  return text;
}

function airtableUrl(offset) {
  const url = new URL(AIRTABLE_API_URL);
  url.searchParams.set("pageSize", String(AIRTABLE_PAGE_SIZE));
  url.searchParams.set("maxRecords", String(MAX_AIRTABLE_RECORDS));
  url.searchParams.set("returnFieldsByFieldId", "true");
  url.searchParams.set("filterByFormula", '{Status}="Pending"');
  for (const fieldId of Object.values(AIRTABLE_FIELDS)) url.searchParams.append("fields[]", fieldId);
  if (offset) url.searchParams.set("offset", offset);
  return url;
}

async function fetchAirtablePage({ token, fetchImpl, offset }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AIRTABLE_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(airtableUrl(offset), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new RelayError("airtable-timeout", "Airtable request timed out");
      throw new RelayError("airtable-read", "Airtable request failed");
    }

    if (response?.status !== 200) {
      throw new RelayError("airtable-read", `Airtable returned HTTP ${response?.status ?? "unknown"}`);
    }

    const text = await readBoundedResponseText(response, MAX_AIRTABLE_RESPONSE_BYTES);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new RelayError("airtable-response", "Airtable response was not valid JSON");
    }
    if (!isPlainObject(payload) || !Array.isArray(payload.records)) {
      throw new RelayError("airtable-response", "Airtable response had an invalid record list");
    }
    if (payload.offset !== undefined && typeof payload.offset !== "string") {
      throw new RelayError("airtable-response", "Airtable response had an invalid pagination offset");
    }
    return { records: payload.records, offset: payload.offset ?? null };
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError("airtable-read", "Airtable request could not be completed");
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPendingRecords({ token = process.env.AIRTABLE_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  requireToken(token);
  if (typeof fetchImpl !== "function") throw new RelayError("airtable-read", "Node fetch is unavailable");

  const records = [];
  let offset = null;
  for (let page = 0; page < Math.ceil(MAX_AIRTABLE_RECORDS / AIRTABLE_PAGE_SIZE); page += 1) {
    const result = await fetchAirtablePage({ token, fetchImpl, offset });
    records.push(...result.records);
    if (!result.offset || records.length >= MAX_AIRTABLE_RECORDS) break;
    offset = result.offset;
  }
  return records.slice(0, MAX_AIRTABLE_RECORDS);
}

function createdTimestamp(record) {
  const timestamp = Date.parse(record?.createdTime ?? "");
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export function selectPendingRecords(records) {
  if (!Array.isArray(records)) throw new RelayError("airtable-response", "Airtable record list was invalid");
  return records
    .map((record, index) => ({ record, index, createdAt: createdTimestamp(record) }))
    .filter(({ record }) => scalarString(fieldValue(record?.fields, AIRTABLE_FIELDS.status)) === "Pending")
    .sort((left, right) => left.createdAt - right.createdAt || left.index - right.index)
    .slice(0, MAX_QUEUE_JOBS)
    .map(({ record }) => record);
}

export function validatePendingRecord(record, index = 0) {
  if (!isPlainObject(record)) throw queueError("queue-validation", `Airtable record ${index + 1} is not an object`);
  const recordId = requireAirtableRecordId(record.id, index);
  if (!Number.isFinite(Date.parse(record.createdTime ?? ""))) {
    throw queueError("queue-validation", `Airtable record ${index + 1} has an invalid createdTime`);
  }
  if (!isPlainObject(record.fields)) throw queueError("queue-validation", `Airtable record ${index + 1} has invalid fields`);

  const status = scalarString(fieldValue(record.fields, AIRTABLE_FIELDS.status));
  if (status !== "Pending") return null;

  const id = scalarString(fieldValue(record.fields, AIRTABLE_FIELDS.jobId));
  if (!id || byteLength(id) > MAX_QUEUE_ID_BYTES || !QUEUE_ID_RE.test(id)) {
    throw queueError("queue-validation", `Airtable record ${index + 1} has an invalid Job ID`);
  }
  const title = scalarString(fieldValue(record.fields, AIRTABLE_FIELDS.title));
  const body = scalarString(fieldValue(record.fields, AIRTABLE_FIELDS.body));
  const branch = scalarString(fieldValue(record.fields, AIRTABLE_FIELDS.branch));
  if (!title || !body || !branch) {
    throw queueError("queue-validation", `Airtable record ${index + 1} is missing required relay fields`);
  }
  if (byteLength(body) > MAX_ISSUE_BODY_BYTES) {
    throw queueError("queue-validation", `Airtable record ${index + 1} body is too large`);
  }

  let titleInfo;
  let job;
  try {
    titleInfo = parseRelayTitle(title);
    if (!titleInfo) throw new RelayError("payload-validation", "title must start with [pr-relay]");
    job = validateJob(parseIssueBody(body));
  } catch (error) {
    throw queueError("queue-validation", `Airtable record ${index + 1} relay payload is invalid: ${safeErrorMessage(error)}`);
  }
  if (titleInfo.repository.toLowerCase() !== job.upstream.toLowerCase()) {
    throw queueError("queue-validation", `Airtable record ${index + 1} title repository and payload upstream do not match`);
  }
  if (job.upstreamIssue !== undefined && job.upstreamIssue !== titleInfo.issueNumber) {
    throw queueError("queue-validation", `Airtable record ${index + 1} upstreamIssue does not match the title`);
  }
  if (branch !== job.branch) {
    throw queueError("queue-validation", `Airtable record ${index + 1} Branch does not match the validated payload branch`);
  }

  return {
    recordId,
    id,
    title,
    body,
    branch,
    job,
    titleInfo,
    createdAt: Date.parse(record.createdTime),
  };
}

function statusUrl(recordId) {
  return `${AIRTABLE_API_URL}/${encodeURIComponent(recordId)}`;
}

export async function updateAirtableStatus(recordId, status, { token = process.env.AIRTABLE_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  requireToken(token);
  if (!AIRTABLE_RECORD_ID_RE.test(recordId)) throw new RelayError("airtable-write", "Airtable record id is invalid");
  if (!AIRTABLE_STATUSES.has(status)) throw new RelayError("airtable-write", "Airtable status is invalid");
  if (typeof fetchImpl !== "function") throw new RelayError("airtable-write", "Node fetch is unavailable");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AIRTABLE_TIMEOUT_MS);
  try {
    try {
      const response = await fetchImpl(statusUrl(recordId), {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fields: { [AIRTABLE_FIELDS.status]: status } }),
        redirect: "error",
        signal: controller.signal,
      });
      if (response?.status !== 200) {
        throw new RelayError("airtable-write", `Airtable status update returned HTTP ${response?.status ?? "unknown"}`);
      }
      return true;
    } catch (error) {
      if (error?.name === "AbortError") throw new RelayError("airtable-timeout", "Airtable status update timed out");
      if (error instanceof RelayError) throw error;
      throw new RelayError("airtable-write", "Airtable status update failed");
    }
  } finally {
    clearTimeout(timer);
  }
}

export function issueAlreadyContainsBranch(issues, branch) {
  if (!Array.isArray(issues)) return false;
  return issues.some((issue) => {
    if (!issue || issue.pull_request || typeof issue.title !== "string" || !issue.title.startsWith("[pr-relay]")) return false;
    if (typeof issue.body !== "string") return false;
    try {
      const title = parseRelayTitle(issue.title);
      const job = validateJob(parseIssueBody(issue.body));
      return Boolean(title && title.repository.toLowerCase() === job.upstream.toLowerCase() && job.branch === branch);
    } catch {
      return false;
    }
  });
}

async function safeGithubRead(client, secrets) {
  try {
    const issues = await client.listIssues(RELAY_REPOSITORY);
    if (!Array.isArray(issues)) throw new Error("GitHub returned an invalid issue list");
    return issues;
  } catch (error) {
    throw queueError("github-read", `unable to read relay issues: ${safeErrorMessage(error, secrets)}`);
  }
}

async function safeGithubCreate(client, queuedJob, secrets) {
  try {
    return await client.createIssue(RELAY_REPOSITORY, { title: queuedJob.title, body: queuedJob.body });
  } catch (error) {
    throw queueError("github-write", `unable to create relay issue for queue job ${queuedJob.id}: ${safeErrorMessage(error, secrets)}`);
  }
}

async function markStatus(record, status, { airtableToken, fetchImpl }) {
  return updateAirtableStatus(record.recordId, status, { token: airtableToken, fetchImpl });
}

export async function pollQueue({
  enabled = process.env.PR_RELAY_ENABLED === "true",
  airtableToken = process.env.AIRTABLE_TOKEN,
  githubToken = process.env.PR_RELAY_TOKEN,
  client,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!enabled) return { state: "disabled", created: [], skipped: [], failed: [], total: 0 };

  const records = selectPendingRecords(await fetchPendingRecords({ token: airtableToken, fetchImpl }));
  const failed = [];
  const valid = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    try {
      const queuedJob = validatePendingRecord(record, index);
      if (queuedJob) valid.push(queuedJob);
    } catch (error) {
      const recordId = record?.id;
      if (!AIRTABLE_RECORD_ID_RE.test(recordId ?? "")) throw error;
      await updateAirtableStatus(recordId, "Failed", { token: airtableToken, fetchImpl });
      failed.push(recordId);
    }
  }

  if (valid.length === 0) return { state: "completed", created: [], skipped: [], failed, total: records.length };

  const github = client ?? new GithubClient(githubToken);
  const secrets = [airtableToken, githubToken];
  const knownIssues = await safeGithubRead(github, secrets);
  const created = [];
  const skipped = [];

  for (const queuedJob of valid) {
    if (issueAlreadyContainsBranch(knownIssues, queuedJob.branch)) {
      await markStatus(queuedJob, "Consumed", { airtableToken, fetchImpl });
      skipped.push(queuedJob.id);
      continue;
    }
    await safeGithubCreate(github, queuedJob, secrets);
    knownIssues.push({ title: queuedJob.title, body: queuedJob.body });
    await markStatus(queuedJob, "Consumed", { airtableToken, fetchImpl });
    created.push(queuedJob.id);
  }

  return { state: "completed", created, skipped, failed, total: records.length };
}

async function main() {
  if (process.env.PR_RELAY_ENABLED !== "true") {
    console.log("PR relay queue polling disabled; no write performed.");
    return;
  }
  const result = await pollQueue({
    enabled: true,
    airtableToken: process.env.AIRTABLE_TOKEN,
    githubToken: process.env.PR_RELAY_TOKEN,
  });
  const failed = result.failed.length > 0 ? ` failed=${result.failed.length}` : "";
  console.log(`PR relay queue poll complete: total=${result.total} created=${result.created.length} skipped=${result.skipped.length}${failed}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const relayError = error instanceof RelayError ? error : new RelayError("queue", "Airtable queue polling failed");
    console.error(sanitizeQueueDiagnostic(`PR relay queue polling stopped [${relayError.stage}]: ${relayError.message}`));
    process.exitCode = 1;
  });
}
