import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export const RELAY_OWNER = "aryansk";
export const RELAY_REPOSITORY = "aryansk/pr-relay";
export const MAX_ISSUE_BODY_BYTES = 128 * 1024;
export const MAX_PATCH_BYTES = 512 * 1024;
export const MAX_PR_BODY_BYTES = 16 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024;
export const GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const API_TIMEOUT_MS = 30 * 1000;

const STATE_LABELS = ["relay/pending", "relay/running", "relay/success", "relay/failed"];
const RETRY_LABEL = "relay/retry";
const TERMINAL_STATES = new Set(["success", "failed"]);
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;
const REPOSITORY_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/;
const REPOSITORY_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})?$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/;
const SENSITIVE_PATH_PATTERNS = [
  { test: (value) => value === ".github" || value.startsWith(".github/"), reason: "GitHub automation and workflow path" },
  { test: (value) => /^\.gitlab-ci(?:\.(?:yml|yaml))?$/i.test(value), reason: "GitLab CI configuration" },
  { test: (value) => value === ".travis.yml", reason: "Travis CI configuration" },
  { test: (value) => value === "appveyor.yml", reason: "AppVeyor configuration" },
  { test: (value) => value === "azure-pipelines.yml", reason: "Azure Pipelines configuration" },
  { test: (value) => value === "buildspec.yml", reason: "AWS CodeBuild configuration" },
  { test: (value) => value === "drone.yml", reason: "Drone CI configuration" },
  { test: (value) => value === "Jenkinsfile", reason: "Jenkins automation" },
  { test: (value) => value === "Makefile" || value === "GNUmakefile" || value === "makefile", reason: "make automation entrypoint" },
  { test: (value) => value === "justfile" || value === "Justfile", reason: "just automation entrypoint" },
  { test: (value) => value === "Taskfile.yml" || value === "Taskfile.yaml", reason: "Task automation entrypoint" },
  { test: (value) => value.startsWith(".circleci/"), reason: "CircleCI configuration" },
  { test: (value) => value.startsWith(".buildkite/"), reason: "Buildkite configuration" },
  { test: (value) => value === ".npmrc" || value === ".pypirc" || value === ".yarnrc" || value === ".yarnrc.yml", reason: "package registry credential configuration" },
  { test: (value) => value === ".docker/config.json" || value.endsWith("/.docker/config.json"), reason: "Docker credential configuration" },
  { test: (value) => /(^|\/)(?:\.env(?:\..*)?|.*(?:credential|secret|password|token|private[-_]?key|service[-_]?account).*|id_rsa(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks))$/i.test(value), reason: "credential or private-key-like path" },
  { test: (value) => /(^|\/)terraform\.tfstate(?:\..*)?$/i.test(value), reason: "Terraform state" },
];

export class RelayError extends Error {
  constructor(stage, message, options = {}) {
    super(message);
    this.name = "RelayError";
    this.stage = stage;
    this.cause = options.cause;
  }
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnsafeText(value, field, { newlines = false, tabs = false } = {}) {
  if (typeof value !== "string") {
    throw new RelayError("payload-validation", `${field} must be a string`);
  }
  if (value.includes("\u0000") || value.includes("\r")) {
    throw new RelayError("payload-validation", `${field} contains a forbidden control character`);
  }
  if (UNSAFE_CONTROL_RE.test(value)) {
    throw new RelayError("payload-validation", `${field} contains a forbidden control character or Unicode format character`);
  }
  if (!newlines && value.includes("\n")) {
    throw new RelayError("payload-validation", `${field} must not contain newlines`);
  }
  if (!tabs && value.includes("\t")) {
    throw new RelayError("payload-validation", `${field} must not contain tabs`);
  }
}

export function redactSecrets(value, secret = process.env.PR_RELAY_TOKEN) {
  let text = String(value ?? "");
  if (secret) {
    text = text.split(secret).join("[redacted-token]");
  }
  return text
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gi, "[redacted-token]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/gi, "[redacted-token]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(x-access-token\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

export function sanitizeForComment(value, maxBytes = 2_000) {
  let text = redactSecrets(value)
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
    .replace(/::/g, "∷")
    .replace(/\r/g, "")
    .trim();
  if (byteLength(text) <= maxBytes) return text;
  let output = "";
  for (const character of text) {
    if (byteLength(output + character + "…") > maxBytes) break;
    output += character;
  }
  return `${output}…`;
}

export function parseRepository(value, field = "repository") {
  if (typeof value !== "string" || value.length > 201 || value.includes("\\") || value.includes("\n") || value.includes("\t")) {
    throw new RelayError("payload-validation", `${field} is not a valid owner/repository name`);
  }
  const parts = value.split("/");
  if (parts.length !== 2) {
    throw new RelayError("payload-validation", `${field} must be in owner/repository form`);
  }
  const [owner, repository] = parts;
  if (!REPOSITORY_OWNER_RE.test(owner) || !REPOSITORY_NAME_RE.test(repository)) {
    throw new RelayError("payload-validation", `${field} contains an invalid owner or repository name`);
  }
  return { owner, repository, fullName: `${owner}/${repository}` };
}

export function validateBranchName(value, { field = "branch", allowDefault = false } = {}) {
  if (typeof value !== "string" || byteLength(value) > 120 || value.length < 2) {
    throw new RelayError("payload-validation", `${field} is not a valid branch name`);
  }
  if (!SAFE_BRANCH_RE.test(value) || /[~^:?*\[\]\\\s]/.test(value)) {
    throw new RelayError("payload-validation", `${field} contains forbidden branch characters`);
  }
  if (value.startsWith("refs/") || value === "HEAD" || value.includes("//") || value.includes("..") || value.includes("@{")) {
    throw new RelayError("payload-validation", `${field} contains a dangerous ref sequence`);
  }
  for (const component of value.split("/")) {
    if (!component || component === "." || component === ".." || component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock") || component.startsWith("-")) {
      throw new RelayError("payload-validation", `${field} contains a dangerous path component`);
    }
  }
  if (!allowDefault && /^(?:main|master|develop|trunk|production|release)$/i.test(value)) {
    throw new RelayError("payload-validation", `${field} may not be a default or protected branch`);
  }
  return value;
}

function validateStringField(value, field, { min = 0, maxBytes, newlines = false, tabs = false } = {}) {
  rejectUnsafeText(value, field, { newlines, tabs });
  if (value.trim().length < min) {
    throw new RelayError("payload-validation", `${field} must not be empty`);
  }
  if (maxBytes !== undefined && byteLength(value) > maxBytes) {
    throw new RelayError("payload-validation", `${field} is too large`);
  }
  return value;
}

function normalizePatch(value) {
  if (typeof value !== "string") {
    throw new RelayError("patch-validation", "patch must be a string");
  }
  if (byteLength(value) > MAX_PATCH_BYTES) {
    throw new RelayError("patch-validation", `patch exceeds the ${MAX_PATCH_BYTES}-byte limit`);
  }
  if (value.includes("\u0000") || UNSAFE_CONTROL_RE.test(value.replace(/\r\n/g, "\n"))) {
    throw new RelayError("patch-validation", "patch contains a forbidden control or Unicode format character");
  }
  if (value.includes("\r") && !value.includes("\r\n")) {
    throw new RelayError("patch-validation", "patch contains a forbidden carriage return");
  }
  return value.replace(/\r\n/g, "\n");
}

function validatePatchPath(value) {
  if (!value || value === "." || value.startsWith("/") || value.startsWith("~") || value.includes("\\") || value.includes("\u0000")) {
    throw new RelayError("patch-validation", "patch contains an absolute or otherwise unsafe path");
  }
  if (value.split("/").some((component) => component === "" || component === "." || component === "..")) {
    throw new RelayError("patch-validation", "patch contains a path traversal component");
  }
  if (value === ".git" || value.startsWith(".git/")) {
    throw new RelayError("patch-validation", "patch may not modify Git metadata");
  }
  if (UNSAFE_CONTROL_RE.test(value)) {
    throw new RelayError("patch-validation", "patch path contains a forbidden Unicode format character");
  }
  return value;
}

function pathFromPatchHeader(raw, prefix) {
  const candidate = raw.trimEnd();
  if (candidate === "/dev/null") return null;
  if (candidate.startsWith('"') || candidate.endsWith('"')) {
    throw new RelayError("patch-validation", "quoted patch paths are not accepted");
  }
  if (!candidate.startsWith(prefix)) {
    throw new RelayError("patch-validation", "patch path header is malformed");
  }
  return validatePatchPath(candidate.slice(prefix.length));
}

export function parsePatchPaths(patch) {
  const paths = new Set();
  let hasDiffHeader = false;
  let hasHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      hasDiffHeader = true;
      const rest = line.slice("diff --git ".length);
      if (rest.includes('"')) {
        throw new RelayError("patch-validation", "quoted diff paths are not accepted");
      }
      const match = /^a\/(.+)\s+b\/(.+)$/.exec(rest);
      if (!match) {
        throw new RelayError("patch-validation", "diff header is malformed");
      }
      paths.add(validatePatchPath(match[1]));
      paths.add(validatePatchPath(match[2]));
    } else if (line.startsWith("--- ")) {
      const parsed = pathFromPatchHeader(line.slice(4).split("\t", 1)[0], "a/");
      if (parsed) paths.add(parsed);
    } else if (line.startsWith("+++ ")) {
      const parsed = pathFromPatchHeader(line.slice(4).split("\t", 1)[0], "b/");
      if (parsed) paths.add(parsed);
    } else if (line.startsWith("@@ ") || line.startsWith("@@-")) {
      hasHunk = true;
    }
  }
  if (!hasDiffHeader || paths.size === 0 || !hasHunk) {
    throw new RelayError("patch-validation", "patch is not a unified git diff with a file path and hunk");
  }
  return [...paths];
}

export function validatePatchText(value) {
  const patch = normalizePatch(value);
  if (!patch.trim()) {
    throw new RelayError("patch-validation", "patch must not be empty");
  }
  if (patch.includes("GIT binary patch") || /^Binary files /m.test(patch)) {
    throw new RelayError("patch-validation", "binary patches are not accepted");
  }
  if (patch.split("\n").length > 50_000) {
    throw new RelayError("patch-validation", "patch has too many lines");
  }
  parsePatchPaths(patch);
  return patch;
}

export function sensitivePathReason(value) {
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(value)) return pattern.reason;
  }
  return null;
}

export function parseAllowedSensitivePaths(value = "") {
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean).filter((item) => {
    try {
      validatePatchPath(item.endsWith("/**") ? item.slice(0, -3) : item);
      return true;
    } catch {
      return false;
    }
  });
}

function pathMatchesAllowlist(value, allowlist) {
  return allowlist.some((pattern) => {
    if (pattern.endsWith("/**")) return value === pattern.slice(0, -3) || value.startsWith(`${pattern.slice(0, -3)}/`);
    return value === pattern;
  });
}

export function validateChangedPaths(paths, { allowlist = [] } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new RelayError("patch-validation", "patch produced no file paths");
  }
  for (const rawPath of paths) {
    const value = validatePatchPath(rawPath);
    const reason = sensitivePathReason(value);
    if (reason && !pathMatchesAllowlist(value, allowlist)) {
      throw new RelayError("sensitive-path", `${value} is blocked by the default sensitive-path policy (${reason})`);
    }
  }
  return true;
}

export function validateJob(raw) {
  if (!isPlainObject(raw)) {
    throw new RelayError("payload-validation", "payload must be a JSON object");
  }
  const allowedKeys = new Set(["version", "upstream", "fork", "base", "branch", "commitMessage", "prTitle", "prBody", "patch", "draft", "upstreamIssue"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new RelayError("payload-validation", `unknown payload field: ${key}`);
    }
  }
  const required = ["version", "upstream", "fork", "base", "branch", "commitMessage", "prTitle", "prBody", "patch", "draft"];
  for (const key of required) {
    if (!(key in raw)) throw new RelayError("payload-validation", `missing required field: ${key}`);
  }
  if (raw.version !== 1) throw new RelayError("payload-validation", "version must be 1");
  const upstream = parseRepository(raw.upstream, "upstream");
  const fork = parseRepository(raw.fork, "fork");
  if (fork.owner !== RELAY_OWNER) {
    throw new RelayError("payload-validation", `fork owner must be exactly ${RELAY_OWNER}`);
  }
  if (upstream.fullName.toLowerCase() === fork.fullName.toLowerCase() || upstream.owner.toLowerCase() === RELAY_OWNER) {
    throw new RelayError("payload-validation", "upstream and fork must be distinct and upstream may not be owned by the relay account");
  }
  validateBranchName(raw.base, { field: "base", allowDefault: true });
  validateBranchName(raw.branch, { field: "branch" });
  validateStringField(raw.commitMessage, "commitMessage", { min: 1, maxBytes: 4_000, newlines: true, tabs: true });
  validateStringField(raw.prTitle, "prTitle", { min: 1, maxBytes: 256 });
  const prBody = validateStringField(raw.prBody, "prBody", { maxBytes: MAX_PR_BODY_BYTES, newlines: true, tabs: true });
  if (prBody.includes("<!-- pr-relay-")) {
    throw new RelayError("payload-validation", "prBody may not contain relay status markers");
  }
  const patch = validatePatchText(raw.patch);
  if (typeof raw.draft !== "boolean") throw new RelayError("payload-validation", "draft must be a boolean");
  if (raw.upstreamIssue !== undefined && (!Number.isInteger(raw.upstreamIssue) || raw.upstreamIssue < 1 || raw.upstreamIssue > 999_999_999)) {
    throw new RelayError("payload-validation", "upstreamIssue must be a positive issue number");
  }
  return {
    version: 1,
    upstream: upstream.fullName,
    fork: fork.fullName,
    base: raw.base,
    branch: raw.branch,
    commitMessage: raw.commitMessage,
    prTitle: raw.prTitle,
    prBody,
    patch,
    draft: raw.draft,
    ...(raw.upstreamIssue === undefined ? {} : { upstreamIssue: raw.upstreamIssue }),
  };
}

export function parseIssueBody(body) {
  if (typeof body !== "string" || byteLength(body) > MAX_ISSUE_BODY_BYTES) {
    throw new RelayError("payload-validation", `issue body exceeds the ${MAX_ISSUE_BODY_BYTES}-byte limit or is not text`);
  }
  let source = body.trim();
  const fenced = /^```json\n([\s\S]*?)\n```$/i.exec(source);
  if (fenced) source = fenced[1];
  if (!source.startsWith("{") || !source.endsWith("}")) {
    throw new RelayError("payload-parse", "issue body must contain one JSON object, optionally inside one json code fence");
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new RelayError("payload-parse", `issue body is not valid JSON: ${sanitizeForComment(error.message, 300)}`, { cause: error });
  }
}

export function parseRelayTitle(title) {
  if (typeof title !== "string" || !title.startsWith("[pr-relay]")) return null;
  const match = /^\[pr-relay\]\s+([^\s]+)\s+#([1-9][0-9]*)$/.exec(title.trim());
  if (!match) {
    throw new RelayError("payload-validation", "title must be exactly [pr-relay] owner/repository #issue-number");
  }
  const repository = parseRepository(match[1], "title repository");
  return { repository: repository.fullName, issueNumber: Number(match[2]) };
}

export function deriveJobId(repository, issueNumber) {
  const seed = `${repository}#${issueNumber}`;
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 20);
  return `relay-${issueNumber}-${digest}`;
}

export function resultMarker(jobId, state) {
  if (!TERMINAL_STATES.has(state)) throw new Error("result marker state must be terminal");
  return `<!-- pr-relay-result job=${jobId} state=${state} -->`;
}

export function findProcessedResult(comments, jobId) {
  if (!Array.isArray(comments)) return null;
  for (const comment of [...comments].reverse()) {
    const body = typeof comment?.body === "string" ? comment.body : "";
    for (const state of TERMINAL_STATES) {
      if (body.includes(resultMarker(jobId, state))) {
        return { state, body, url: comment.html_url ?? null };
      }
    }
  }
  return null;
}

function issueReferenceMatches(text, issueNumber) {
  if (typeof text !== "string") return false;
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`#${escaped}(?:\\b|$)`).test(text) || new RegExp(`(?:/issues/|\\bissues/)${escaped}(?:\\b|$)`).test(text);
}

function encodePathPart(value) {
  return String(value).split("/").map((part) => encodeURIComponent(part)).join("/");
}

function baseEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "PR_RELAY_TOKEN",
    "GITHUB_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_PAGER",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ]) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.GIT_ALLOW_PROTOCOL = "https:file";
  return env;
}

function gitEnvironment(token) {
  const env = baseEnvironment();
  if (!token) return env;
  const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${authorization}`;
  env.GIT_CURL_VERBOSE = "0";
  env.GIT_TRACE = "0";
  return env;
}

export function runCommand(command, args, { cwd, env = {}, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...baseEnvironment(), ...env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const collect = (target, chunk) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout = `${stdout}${text}`.slice(-MAX_COMMAND_OUTPUT_BYTES);
      else stderr = `${stderr}${text}`.slice(-MAX_COMMAND_OUTPUT_BYTES);
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new RelayError("command", `unable to start ${command}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new RelayError("command-timeout", `${command} timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        const detail = sanitizeForComment(stderr || stdout, 800);
        reject(new RelayError("command", `${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}${detail ? `: ${detail}` : ""}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function runGit(args, { cwd, token, stage, timeoutMs = GIT_TIMEOUT_MS, network = false } = {}) {
  try {
    return await runCommand("git", args, { cwd, env: network ? gitEnvironment(token) : baseEnvironment(), timeoutMs });
  } catch (error) {
    if (error instanceof RelayError) throw new RelayError(stage, error.message, { cause: error });
    throw new RelayError(stage, "git command failed", { cause: error });
  }
}

async function readGitPaths(cwd) {
  const result = await runGit(["diff", "--cached", "--name-only", "-z"], { cwd, stage: "patch-validation" });
  return result.stdout.split("\u0000").filter(Boolean);
}

async function withTemporaryDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pr-relay-"));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function applyPatchAndPush({ job, token }) {
  const allowlist = parseAllowedSensitivePaths(process.env.PR_RELAY_ALLOWED_SENSITIVE_PATHS ?? "");
  return withTemporaryDirectory(async (directory) => {
    const repositoryDirectory = path.join(directory, "repository");
    const patchFile = path.join(directory, "change.patch");
    const commitMessageFile = path.join(directory, "commit-message.txt");
    const upstreamUrl = `https://github.com/${job.upstream}.git`;
    const forkUrl = `https://github.com/${job.fork}.git`;

    await fs.mkdir(repositoryDirectory, { recursive: true });
    await runGit(["init", "--initial-branch=relay-base", repositoryDirectory], { cwd: directory, stage: "clone" });
    await runGit(["remote", "add", "upstream", upstreamUrl], { cwd: repositoryDirectory, stage: "clone" });
    await runGit(["fetch", "--no-tags", "--depth=1", "upstream", `refs/heads/${job.base}`], { cwd: repositoryDirectory, token, network: true, stage: "fetch" });
    await runGit(["checkout", "--detach", "FETCH_HEAD"], { cwd: repositoryDirectory, stage: "checkout" });
    await runGit(["switch", "--create", job.branch], { cwd: repositoryDirectory, stage: "branch" });
    await runGit(["remote", "add", "fork", forkUrl], { cwd: repositoryDirectory, stage: "checkout" });

    await fs.writeFile(patchFile, job.patch, { encoding: "utf8", mode: 0o600 });
    await runGit(["apply", "--check", "--recount", "--whitespace=error-all", "--", patchFile], { cwd: repositoryDirectory, stage: "patch-validation" });
    await runGit(["apply", "--index", "--recount", "--whitespace=error-all", "--", patchFile], { cwd: repositoryDirectory, stage: "patch-apply" });

    const changedPaths = await readGitPaths(repositoryDirectory);
    validateChangedPaths(changedPaths, { allowlist });
    const summary = await runGit(["diff", "--cached", "--summary"], { cwd: repositoryDirectory, stage: "patch-validation" });
    if (/(?:create|new file|mode)\s+mode 120000|(?:create|new file|mode)\s+mode 160000/i.test(summary.stdout)) {
      throw new RelayError("patch-validation", "symbolic-link and submodule changes are not accepted");
    }
    await runGit(["diff", "--cached", "--check"], { cwd: repositoryDirectory, stage: "patch-validation" });
    if (changedPaths.length === 0) throw new RelayError("patch-validation", "patch produced zero changes");

    await runGit(["config", "user.name", "pr-relay"], { cwd: repositoryDirectory, stage: "commit" });
    await runGit(["config", "user.email", "pr-relay@users.noreply.github.com"], { cwd: repositoryDirectory, stage: "commit" });
    await fs.writeFile(commitMessageFile, `${job.commitMessage}\n`, { encoding: "utf8", mode: 0o600 });
    await runGit(["commit", "--no-gpg-sign", "-F", commitMessageFile, "--"], { cwd: repositoryDirectory, stage: "commit" });
    const shaResult = await runGit(["rev-parse", "HEAD"], { cwd: repositoryDirectory, stage: "commit" });
    const sha = shaResult.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new RelayError("commit", "git did not return a valid commit SHA");

    await runGit(["push", "--porcelain", "fork", `HEAD:refs/heads/${job.branch}`], { cwd: repositoryDirectory, token, network: true, stage: "push" });
    return { sha, changedPaths };
  });
}

export class GithubClient {
  constructor(token, { apiBase = "https://api.github.com" } = {}) {
    if (!token) throw new RelayError("auth-setup", "PR_RELAY_TOKEN is not configured");
    this.token = token;
    this.apiBase = apiBase;
  }

  async request(method, requestPath, { query = {}, body, allow404 = false, timeoutMs = API_TIMEOUT_MS } = {}) {
    const url = new URL(requestPath, this.apiBase);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let responseText = "";
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      responseText = await response.text();
    } catch (error) {
      if (error?.name === "AbortError") throw new RelayError("github-api", `GitHub API request timed out: ${method} ${requestPath}`);
      throw new RelayError("github-api", `GitHub API request failed: ${sanitizeForComment(error.message, 500)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      const detail = responseText ? sanitizeForComment(responseText, 700) : "no response body";
      throw new RelayError("github-api", `GitHub API ${method} ${requestPath} returned HTTP ${response.status}: ${detail}`);
    }
    if (!responseText) return null;
    try {
      return JSON.parse(responseText);
    } catch (error) {
      throw new RelayError("github-api", `GitHub API returned invalid JSON for ${method} ${requestPath}`, { cause: error });
    }
  }

  async list(requestPath, query = {}, { maxPages = 10 } = {}) {
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const pageItems = await this.request("GET", requestPath, { query: { ...query, per_page: 100, page } });
      if (!Array.isArray(pageItems) || pageItems.length === 0) break;
      items.push(...pageItems);
      if (pageItems.length < 100) break;
    }
    return items;
  }

  async getRepository(repository) {
    return this.request("GET", `/repos/${repository}`);
  }

  async getIssue(repository, issueNumber) {
    return this.request("GET", `/repos/${repository}/issues/${issueNumber}`);
  }

  async getIssueComments(repository, issueNumber) {
    return this.list(`/repos/${repository}/issues/${issueNumber}/comments`);
  }

  async getIssueLabels(repository, issueNumber) {
    return this.list(`/repos/${repository}/issues/${issueNumber}/labels`);
  }

  async getLabel(repository, label) {
    return this.request("GET", `/repos/${repository}/labels/${encodeURIComponent(label)}`, { allow404: true });
  }

  async ensureLabel(repository, label, color, description) {
    const existing = await this.getLabel(repository, label);
    if (existing) return existing;
    try {
      return await this.request("POST", `/repos/${repository}/labels`, { body: { name: label, color, description } });
    } catch (error) {
      const raced = await this.getLabel(repository, label).catch(() => null);
      if (raced) return raced;
      throw error;
    }
  }

  async addIssueLabels(repository, issueNumber, labels) {
    if (labels.length === 0) return;
    await this.request("POST", `/repos/${repository}/issues/${issueNumber}/labels`, { body: { labels } });
  }

  async removeIssueLabel(repository, issueNumber, label) {
    await this.request("DELETE", `/repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, { allow404: true });
  }

  async addIssueComment(repository, issueNumber, body) {
    return this.request("POST", `/repos/${repository}/issues/${issueNumber}/comments`, { body: { body } });
  }

  async findPullRequestsForBranch(repository, branch, base) {
    return this.list(`/repos/${repository}/pulls`, { state: "all", head: `${RELAY_OWNER}:${branch}`, base });
  }

  async branchExists(repository, branch) {
    const ref = `heads/${encodePathPart(branch)}`;
    return Boolean(await this.request("GET", `/repos/${repository}/git/ref/${ref}`, { allow404: true }));
  }

  async findIssuePullRequests(repository, issueNumber) {
    const query = `repo:${repository} is:pr is:open author:${RELAY_OWNER} ${issueNumber}`;
    const response = await this.request("GET", "/search/issues", { query: { q: query, per_page: 100 } });
    const items = Array.isArray(response?.items) ? response.items : [];
    return items.filter((item) => item?.user?.login === RELAY_OWNER && issueReferenceMatches(`${item.title ?? ""}\n${item.body ?? ""}`, issueNumber));
  }

  async createPullRequest(repository, payload) {
    return this.request("POST", `/repos/${repository}/pulls`, { body: payload });
  }
}

async function ensureStateLabels(client) {
  const definitions = {
    "relay/pending": ["fbca04", "Relay job accepted and queued"],
    "relay/running": ["1d76db", "Relay job is running"],
    "relay/success": ["2da44e", "Relay job created a pull request"],
    "relay/failed": ["cf222e", "Relay job failed safely"],
    "relay/retry": ["fbca04", "Explicitly retry a failed relay job"],
  };
  for (const label of [...STATE_LABELS, RETRY_LABEL]) {
    await client.ensureLabel(RELAY_REPOSITORY, label, definitions[label][0], definitions[label][1]);
  }
}

async function setIssueState(client, issueNumber, state) {
  await client.addIssueLabels(RELAY_REPOSITORY, issueNumber, [`relay/${state}`]);
  for (const other of ["pending", "running", "success", "failed"].filter((item) => item !== state)) {
    await client.removeIssueLabel(RELAY_REPOSITORY, issueNumber, `relay/${other}`);
  }
}

async function removeRetryLabelBestEffort(client, issueNumber) {
  try {
    await client.removeIssueLabel(RELAY_REPOSITORY, issueNumber, RETRY_LABEL);
  } catch (error) {
    console.error(sanitizeForComment(`Unable to remove retry label after success: ${error?.message ?? error}`, 800));
  }
}

function buildResultComment(jobId, state, details = {}) {
  const marker = resultMarker(jobId, state);
  if (state === "success") {
    return [
      "SUCCESS",
      `PR: ${sanitizeForComment(details.prUrl, 500)}`,
      `Branch: ${sanitizeForComment(details.branch, 150)}`,
      `Commit: ${sanitizeForComment(details.sha, 100)}`,
      "",
      marker,
    ].join("\n");
  }
  return [
    "FAILED",
    `Stage: ${sanitizeForComment(details.stage, 120)}`,
    `Reason: ${sanitizeForComment(details.reason, 1_000)}`,
    "",
    marker,
  ].join("\n");
}

function requiredToken() {
  const token = process.env.PR_RELAY_TOKEN;
  if (!token) throw new RelayError("auth-setup", "PR_RELAY_TOKEN is not configured");
  return token;
}

async function validateRemoteRepositories(client, job) {
  const upstream = await client.getRepository(job.upstream);
  if (!upstream || upstream.private || upstream.visibility === "private") {
    throw new RelayError("repository-validation", "upstream must be a public GitHub repository");
  }
  const fork = await client.getRepository(job.fork);
  if (!fork || fork.owner?.login !== RELAY_OWNER) {
    throw new RelayError("repository-validation", `fork owner must be exactly ${RELAY_OWNER}`);
  }
  if (!fork.fork || fork.parent?.full_name?.toLowerCase() !== job.upstream.toLowerCase()) {
    throw new RelayError("repository-validation", "fork does not directly correspond to the requested upstream repository");
  }
  const baseBranch = await client.request("GET", `/repos/${job.upstream}/branches/${encodePathPart(job.base)}`, { allow404: true });
  if (!baseBranch) throw new RelayError("repository-validation", `upstream base branch does not exist: ${job.base}`);
  return { upstream, fork };
}

async function duplicateCheck(client, job, issueNumber) {
  const existingPrs = await client.findPullRequestsForBranch(job.upstream, job.branch, job.base);
  if (existingPrs.length > 0) return { kind: "pr", pullRequest: existingPrs[0] };
  if (await client.branchExists(job.fork, job.branch)) return { kind: "branch" };
  const issuePrs = await client.findIssuePullRequests(job.upstream, issueNumber);
  if (issuePrs.length > 0) return { kind: "pr", pullRequest: issuePrs[0] };
  return null;
}

function existingPrUrl(existing) {
  return existing?.pullRequest?.html_url ?? existing?.pullRequest?.url ?? null;
}

async function terminalCommentIfMissing(client, issueNumber, comments, jobId, body, state) {
  if (comments.some((comment) => typeof comment?.body === "string" && comment.body.includes(resultMarker(jobId, state)))) return;
  await client.addIssueComment(RELAY_REPOSITORY, issueNumber, body);
}

export async function processRelayEvent(event, { client, enabled = process.env.PR_RELAY_ENABLED === "true", runId = process.env.PR_RELAY_RUN_ID ?? "unknown" } = {}) {
  if (!enabled) return { state: "disabled" };
  if (event?.repository?.full_name !== RELAY_REPOSITORY) return { state: "ignored", reason: "wrong repository" };
  const issue = event.issue;
  if (!issue || issue.pull_request || !Number.isInteger(issue.number)) return { state: "ignored", reason: "not an issue event" };
  if (typeof issue.title !== "string" || !issue.title.startsWith("[pr-relay]")) return { state: "ignored", reason: "not a relay issue" };
  const token = client ? null : requiredToken();
  const github = client ?? new GithubClient(token);
  const jobId = deriveJobId(RELAY_REPOSITORY, issue.number);
  const initialComments = await github.getIssueComments(RELAY_REPOSITORY, issue.number);
  const previous = findProcessedResult(initialComments, jobId);
  const retryRequested = event.action === "labeled" && event.label?.name === "relay/retry";
  if (previous && !(retryRequested && previous.state === "failed")) return { state: "already-processed", previous };

  await ensureStateLabels(github);
  await setIssueState(github, issue.number, "pending");
  await setIssueState(github, issue.number, "running");

  try {
    const title = parseRelayTitle(issue.title);
    const raw = parseIssueBody(issue.body ?? "");
    const job = validateJob(raw);
    if (title.repository.toLowerCase() !== job.upstream.toLowerCase()) {
      throw new RelayError("payload-validation", "title repository and payload upstream do not match");
    }
    if (job.upstreamIssue !== undefined && job.upstreamIssue !== title.issueNumber) {
      throw new RelayError("payload-validation", "upstreamIssue does not match the relay issue title");
    }

    await validateRemoteRepositories(github, job);
    const duplicate = await duplicateCheck(github, job, title.issueNumber);
    if (duplicate?.kind === "pr") {
      const url = existingPrUrl(duplicate);
      if (!url) throw new RelayError("duplicate-protection", "an existing pull request was found but has no usable URL");
      await setIssueState(github, issue.number, "success");
      await terminalCommentIfMissing(github, issue.number, initialComments, jobId, buildResultComment(jobId, "success", { prUrl: url, branch: job.branch, sha: "existing pull request" }), "success");
      await removeRetryLabelBestEffort(github, issue.number);
      return { state: "success", existing: true, prUrl: url };
    }
    if (duplicate?.kind === "branch") {
      throw new RelayError("duplicate-protection", `fork branch already exists: ${job.branch}`);
    }

    const commit = await applyPatchAndPush({ job, token: github.token });
    const afterPush = await duplicateCheck(github, job, title.issueNumber);
    let pullRequest = afterPush?.pullRequest;
    if (!pullRequest) {
      const body = `${job.prBody.trim()}\n\n<!-- pr-relay-job ${jobId} -->`;
      try {
        pullRequest = await github.createPullRequest(job.upstream, {
          title: job.prTitle,
          head: `${RELAY_OWNER}:${job.branch}`,
          base: job.base,
          body,
          draft: job.draft,
          maintainer_can_modify: true,
        });
      } catch (error) {
        const raced = await github.findPullRequestsForBranch(job.upstream, job.branch, job.base);
        if (raced.length > 0) pullRequest = raced[0];
        else throw error;
      }
    }
    const prUrl = pullRequest?.html_url ?? pullRequest?.url;
    if (!prUrl) throw new RelayError("pull-request", "GitHub did not return a pull request URL");
    await setIssueState(github, issue.number, "success");
    await terminalCommentIfMissing(github, issue.number, initialComments, jobId, buildResultComment(jobId, "success", { prUrl, branch: job.branch, sha: commit.sha }), "success");
    await removeRetryLabelBestEffort(github, issue.number);
    return { state: "success", prUrl, sha: commit.sha, changedPaths: commit.changedPaths };
  } catch (error) {
    const relayError = error instanceof RelayError ? error : new RelayError("unknown", sanitizeForComment(error?.message ?? error, 800), { cause: error });
    const reason = sanitizeForComment(relayError.message, 1_000);
    try {
      await setIssueState(github, issue.number, "failed");
      await terminalCommentIfMissing(github, issue.number, initialComments, jobId, buildResultComment(jobId, "failed", { stage: relayError.stage, reason }), "failed");
    } catch (statusError) {
      console.error(sanitizeForComment(`Unable to record relay failure: ${statusError?.message ?? statusError}`, 1_000));
    }
    console.error(sanitizeForComment(`Relay failed [${relayError.stage}]: ${reason}`, 1_200));
    return { state: "failed", stage: relayError.stage, reason };
  } finally {
    try {
      await github.removeIssueLabel(RELAY_REPOSITORY, issue.number, "relay/running");
    } catch (cleanupError) {
      console.error(sanitizeForComment(`Unable to remove running label: ${cleanupError?.message ?? cleanupError}`, 800));
    }
  }
}

async function main() {
  if (process.env.PR_RELAY_ENABLED !== "true") {
    console.log("PR relay disabled; no write performed.");
    return;
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new RelayError("configuration", "GITHUB_EVENT_PATH is not configured");
  let event;
  try {
    event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  } catch (error) {
    throw new RelayError("configuration", `unable to read GitHub event: ${sanitizeForComment(error.message, 500)}`, { cause: error });
  }
  const result = await processRelayEvent(event, { runId: process.env.PR_RELAY_RUN_ID ?? "unknown" });
  if (result?.state === "failed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const relayError = error instanceof RelayError ? error : new RelayError("unknown", error?.message ?? String(error), { cause: error });
    console.error(sanitizeForComment(`PR relay stopped [${relayError.stage}]: ${relayError.message}`, 1_500));
    process.exitCode = 1;
  });
}
