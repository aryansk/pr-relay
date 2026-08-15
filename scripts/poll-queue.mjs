import {
  GithubClient,
  MAX_ISSUE_BODY_BYTES,
  RELAY_REPOSITORY,
  RelayError,
  parseIssueBody,
  parseRelayTitle,
  sanitizeForComment,
  validateJob,
} from "./relay.mjs";

export const QUEUE_URL = "https://pr-relay-trigger-aryanbsk12345-4414s-projects.vercel.app/api/jobs";
export const MAX_QUEUE_JOBS = 5;
export const MAX_QUEUE_RESPONSE_BYTES = 1024 * 1024;
export const QUEUE_TIMEOUT_MS = 10 * 1000;
export const MAX_QUEUE_ID_BYTES = 128;

const QUEUE_ENDPOINT = new URL(QUEUE_URL);
const QUEUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function queueError(stage, message, cause) {
  return new RelayError(stage, sanitizeForComment(message, 1_200), { cause });
}

function requireExactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw queueError("queue-validation", `${label} must be a JSON object`);
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw queueError("queue-validation", `${label} contains unexpected or missing fields`);
  }
}

function validateQueueEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw queueError("queue-fetch", "queue endpoint URL is invalid", error);
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== QUEUE_ENDPOINT.origin ||
    endpoint.pathname !== QUEUE_ENDPOINT.pathname ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  ) {
    throw queueError("queue-fetch", "queue endpoint must be the configured HTTPS Vercel endpoint");
  }
  return endpoint;
}

function headerValue(response, name) {
  return typeof response?.headers?.get === "function" ? response.headers.get(name) : null;
}

async function readBoundedResponseText(response, maxBytes) {
  const contentLength = headerValue(response, "content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw queueError("queue-response", "queue response content length is invalid");
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      throw queueError("queue-response", `queue response exceeds the ${maxBytes}-byte limit`);
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
          throw queueError("queue-response", `queue response exceeds the ${maxBytes}-byte limit`);
        }
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  }

  if (typeof response?.text !== "function") throw queueError("queue-response", "queue response body is unreadable");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw queueError("queue-response", `queue response exceeds the ${maxBytes}-byte limit`);
  }
  return text;
}

export async function fetchQueuePayload({
  queueUrl = QUEUE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = QUEUE_TIMEOUT_MS,
  maxBytes = MAX_QUEUE_RESPONSE_BYTES,
} = {}) {
  const endpoint = validateQueueEndpoint(queueUrl);
  if (typeof fetchImpl !== "function") throw queueError("queue-fetch", "Node fetch is unavailable");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    try {
      response = await fetchImpl(endpoint.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw queueError("queue-timeout", `queue request timed out after ${timeoutMs}ms`, error);
      }
      throw queueError("queue-fetch", `queue request failed: ${error?.message ?? error}`, error);
    }

    if (typeof response?.url === "string" && response.url) {
      try {
        validateQueueEndpoint(response.url);
      } catch (error) {
        throw queueError("queue-fetch", "queue response came from an unexpected URL", error);
      }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response, "location");
      if (location) {
        try {
          const redirected = new URL(location, endpoint);
          if (redirected.protocol !== "https:" || redirected.origin !== endpoint.origin) {
            throw queueError("queue-fetch", "queue redirect targets an unexpected host or non-HTTPS URL");
          }
        } catch (error) {
          if (error instanceof RelayError) throw error;
          throw queueError("queue-fetch", "queue redirect location is invalid", error);
        }
      }
      throw queueError("queue-fetch", "queue redirects are not accepted");
    }
    if (response.status !== 200) {
      throw queueError("queue-fetch", `queue endpoint returned HTTP ${response.status}`);
    }

    let text;
    try {
      text = await readBoundedResponseText(response, maxBytes);
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw queueError("queue-response", `unable to read queue response: ${error?.message ?? error}`, error);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw queueError("queue-parse", `queue response is not valid JSON: ${error.message}`, error);
    }
  } finally {
    clearTimeout(timer);
  }
}

function validateQueueId(value, index) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_QUEUE_ID_BYTES || !QUEUE_ID_RE.test(value)) {
    throw queueError("queue-validation", `queue job ${index + 1} has an invalid id`);
  }
  return value;
}

export function validateQueuedJob(value, index = 0) {
  requireExactKeys(value, ["id", "title", "body"], `queue job ${index + 1}`);
  const id = validateQueueId(value.id, index);
  if (typeof value.title !== "string") throw queueError("queue-validation", `queue job ${index + 1} title must be a string`);
  if (typeof value.body !== "string" || Buffer.byteLength(value.body, "utf8") > MAX_ISSUE_BODY_BYTES) {
    throw queueError("queue-validation", `queue job ${index + 1} body is too large or is not text`);
  }

  try {
    const title = parseRelayTitle(value.title);
    if (!title) throw queueError("queue-validation", `queue job ${index + 1} title must start with [pr-relay]`);
    const raw = parseIssueBody(value.body);
    const job = validateJob(raw);
    if (title.repository.toLowerCase() !== job.upstream.toLowerCase()) {
      throw queueError("queue-validation", `queue job ${index + 1} title repository and payload upstream do not match`);
    }
    if (job.upstreamIssue !== undefined && job.upstreamIssue !== title.issueNumber) {
      throw queueError("queue-validation", `queue job ${index + 1} upstreamIssue does not match the title`);
    }
    return { id, title: value.title, body: value.body, job, titleInfo: title };
  } catch (error) {
    if (error instanceof RelayError && error.stage === "queue-validation") throw error;
    throw queueError("queue-validation", `queue job ${index + 1} relay payload is invalid: ${error?.message ?? error}`, error);
  }
}

export function validateQueuePayload(value) {
  requireExactKeys(value, ["version", "jobs"], "queue response");
  if (value.version !== 1) throw queueError("queue-validation", "queue version must be 1");
  if (!Array.isArray(value.jobs)) throw queueError("queue-validation", "queue jobs must be an array");
  if (value.jobs.length > MAX_QUEUE_JOBS) {
    throw queueError("queue-validation", `queue may contain at most ${MAX_QUEUE_JOBS} jobs per poll`);
  }

  const ids = new Set();
  const jobs = value.jobs.map((item, index) => {
    const validated = validateQueuedJob(item, index);
    if (ids.has(validated.id)) throw queueError("queue-validation", `queue contains duplicate job id: ${validated.id}`);
    ids.add(validated.id);
    return validated;
  });
  return { version: 1, jobs };
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

async function safeGithubRead(client) {
  try {
    const issues = await client.listIssues(RELAY_REPOSITORY);
    if (!Array.isArray(issues)) throw new Error("GitHub returned an invalid issue list");
    return issues;
  } catch (error) {
    throw queueError("github-read", `unable to read relay issues: ${error?.message ?? error}`, error);
  }
}

async function safeGithubCreate(client, queuedJob) {
  try {
    return await client.createIssue(RELAY_REPOSITORY, { title: queuedJob.title, body: queuedJob.body });
  } catch (error) {
    throw queueError("github-write", `unable to create relay issue for queue job ${queuedJob.id}: ${error?.message ?? error}`, error);
  }
}

export async function pollQueue({
  enabled = process.env.PR_RELAY_ENABLED === "true",
  token = process.env.PR_RELAY_TOKEN,
  client,
  fetchImpl = globalThis.fetch,
  queueUrl = QUEUE_URL,
} = {}) {
  if (!enabled) return { state: "disabled", created: [], skipped: [], total: 0 };

  const payload = await fetchQueuePayload({ queueUrl, fetchImpl });
  const queue = validateQueuePayload(payload);
  if (queue.jobs.length === 0) return { state: "completed", created: [], skipped: [], total: 0 };

  const github = client ?? new GithubClient(token);
  const knownIssues = await safeGithubRead(github);
  const created = [];
  const skipped = [];

  for (const queuedJob of queue.jobs) {
    if (issueAlreadyContainsBranch(knownIssues, queuedJob.job.branch)) {
      skipped.push(queuedJob.id);
      continue;
    }
    await safeGithubCreate(github, queuedJob);
    created.push(queuedJob.id);
    knownIssues.push({ title: queuedJob.title, body: queuedJob.body });
  }

  return { state: "completed", created, skipped, total: queue.jobs.length };
}

async function main() {
  if (process.env.PR_RELAY_ENABLED !== "true") {
    console.log("PR relay queue polling disabled; no write performed.");
    return;
  }
  const result = await pollQueue({ enabled: true, token: process.env.PR_RELAY_TOKEN });
  console.log(`PR relay queue poll complete: total=${result.total} created=${result.created.length} skipped=${result.skipped.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const relayError = error instanceof RelayError ? error : new RelayError("queue", error?.message ?? String(error), { cause: error });
    console.error(sanitizeForComment(`PR relay queue polling stopped [${relayError.stage}]: ${relayError.message}`, 1_500));
    process.exitCode = 1;
  });
}
