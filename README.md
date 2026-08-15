# Secure GitHub PR relay

This private repository is a deliberately narrow command queue. ChatGPT creates one issue containing one JSON job; GitHub Actions runs trusted relay code; the relay validates the job, applies the supplied unified diff as data, pushes one new branch to an `aryansk` fork, opens one upstream pull request, and records the result on the issue.

The relay never runs code from the target repository. It does not install dependencies, execute project tests, run build scripts, execute issue-body commands, approve or merge pull requests, force-push, or push to an upstream repository.

## Architecture

```text
ChatGPT GitHub connector
        |
        | creates one [pr-relay] issue in this private repository
        v
GitHub Actions (per-issue concurrency group)
        |
        | trusted scripts/relay.mjs + PR_RELAY_TOKEN
        v
public upstream metadata -> fresh base checkout -> safe git apply
        |
        v
aryansk fork branch -> upstream pull request -> relay issue result
```

The workflow uses a read-only `GITHUB_TOKEN` for checkout. Requested GitHub writes use `PR_RELAY_TOKEN`, which is never hard-coded and is never printed. The repository variable `PR_RELAY_ENABLED` defaults to a safe disabled state until explicitly enabled.

## Zero-click queue

The relay also supports a public, read-only Vercel queue without moving any GitHub credential to Vercel:

```text
ChatGPT publishes validated job -> Vercel queue
        -> scheduled GitHub poller every 5 minutes
        -> [pr-relay] GitHub issue
        -> existing issue-triggered relay
        -> aryansk fork branch
        -> upstream draft PR
```

The configured endpoint is:

```text
https://pr-relay-trigger-aryanbsk12345-4414s-projects.vercel.app/api/jobs
```

The `poll_queue` job also supports `workflow_dispatch` for a manual poll. It uses the existing `PR_RELAY_TOKEN` Actions secret and the same `PR_RELAY_ENABLED` kill switch. Queue polling and issue processing have separate concurrency groups: queue polls cannot overlap, while issue-triggered runs remain isolated by relay issue number.

The queue must return exactly one object with `version: 1` and at most five jobs. Each job has exactly `id`, `title`, and `body`; the ID is a short safe ASCII identifier, the title follows the normal `[pr-relay] owner/repository #123` format, and the body is the exact JSON relay body that will be placed into the GitHub issue. The poller uses the existing `parseRelayTitle`, `parseIssueBody`, and `validateJob` checks before any issue write. It rejects non-HTTPS or redirected endpoints, non-200 responses, oversized/malformed responses, unexpected fields, duplicate IDs, invalid jobs, and title/upstream mismatches.

The poller never clones repositories, applies patches, or executes job data. It reads recent `aryansk/pr-relay` issues, validates their JSON bodies, and skips a queued job when its validated branch is already present. Otherwise it creates exactly one relay issue with the supplied title and body; the existing `issues: opened` path performs all GitHub relay work. A malformed queue or invalid job is rejected before any issue is created. `PR_RELAY_TOKEN` remains only in GitHub Actions and is never sent to Vercel.

## Security model and restrictions

The issue body, title, patch, repository names, branch names, commit message, and PR text are untrusted input.

- The fork owner must be exactly `aryansk`.
- The upstream must be a public GitHub repository, and the fork must be a direct fork of that exact upstream.
- The relay title must be exactly `[pr-relay] owner/repository #123`.
- The base branch is validated; the requested branch must be a new, non-default, safe Git ref.
- Repository names and paths reject absolute paths, traversal components, control characters, shell metacharacters in refs, and Git metadata paths.
- There is no command or script field. All values are passed as argument-array values to `spawn`; `shell` is disabled.
- The patch is size-limited, must be a text unified diff, is checked with `git apply --check`, and is then applied without `--reject` so a partial application cannot be silently accepted.
- Binary patches, symlinks, submodules, empty diffs, malformed diffs, and zero-change results are rejected.
- `.github/**`, other common CI/automation entrypoints, credential-like paths, private keys, environment files, registry configuration, and Terraform state are blocked by default.
- An administrator can explicitly allow a narrow path or directory with the repository variable `PR_RELAY_ALLOWED_SENSITIVE_PATHS`, for example `.github/workflows/approved.yml` or `.github/workflows/**`. The issue payload cannot override this policy.
- Issue body size is limited to 128 KiB and patch size to 512 KiB. Git and API operations have timeouts, and every job uses a fresh temporary directory that is removed in a `finally` block.
- The target repository's package managers, hooks, workflows, tests, builds, and executable files are not run while the credential is present.
- The relay searches for an existing PR from `aryansk` for the requested branch and referenced issue, and for an existing fork branch. A processed issue has a deterministic job ID and terminal result marker. The same issue cannot create a second PR.
- Workflow-level concurrency is keyed by relay issue number, and application-level duplicate checks run before and after the push. Pushes are non-force pushes to `aryansk/<fork>:<branch>` only.
- Status comments contain only a PR URL, branch, commit, or a short sanitized failure reason. Authentication-looking values and workflow-command syntax are redacted.

## Setup

The repository is intended to be private. Do not make it public while it contains a write-capable credential secret.

### 1. Create the credential locally

For this relay's arbitrary-public-upstream use case, a fine-grained PAT is not reliable: GitHub documents that only classic PATs have write access to public repositories not owned by you or an organization you belong to. Use a dedicated, expiring classic PAT as the narrowest practical credential for this architecture.

1. Open GitHub → profile photo → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**.
2. Choose **Generate new token (classic)**, set a short practical expiration, and select only the `repo` scope.
3. Do not select `workflow`, `admin:org`, `delete_repo`, `write:packages`, or unrelated scopes. The default sensitive-path policy also rejects workflow changes.
4. Keep the token in your password manager. Never paste it into ChatGPT, Codex, an issue body, source code, or a terminal transcript.

The classic `repo` scope is broader than ideal because GitHub does not provide a fine-grained PAT that can reliably create PRs against arbitrary public repositories. If all future upstreams are owned by one organization, revisit a fine-grained PAT or GitHub App with repository-specific permissions instead.

### 2. Add the secret directly in GitHub

In **`aryansk/pr-relay` → Settings → Secrets and variables → Actions → Secrets → New repository secret**:

- Name: `PR_RELAY_TOKEN`
- Secret: paste the PAT directly into GitHub

Save it. Do not send the token to Codex or include it in a message.

### 3. Configure the kill switch

In **`aryansk/pr-relay` → Settings → Secrets and variables → Actions → Variables**:

- Create `PR_RELAY_ENABLED` with value `false` while setting up.
- After the secret is saved and you are ready for a test, change it to `true`.
- Leave `PR_RELAY_ALLOWED_SENSITIVE_PATHS` absent or empty unless you have reviewed the exact sensitive path that should be allowed.

When `PR_RELAY_ENABLED` is anything other than the exact string `true`, the job is skipped and no relay write is performed. To stop immediately, set it to `false`, disable the workflow if needed, and revoke/delete `PR_RELAY_TOKEN`. Revoking the token removes the relay's GitHub write access even if a new run starts.

## Job interface

Create an issue in `aryansk/pr-relay` with this exact title shape:

```text
[pr-relay] apify/crawlee-python #1985
```

The body must contain exactly one JSON object, either as plain JSON or as one `json` code fence. Do not add explanatory text, attachments, commands, tokens, or additional JSON objects.

```json
{
  "version": 1,
  "upstream": "apify/crawlee-python",
  "fork": "aryansk/crawlee-python",
  "base": "master",
  "branch": "fix/1985-request-queue-is-finished",
  "commitMessage": "fix: make RequestQueueClient.is_finished abstract",
  "prTitle": "fix: make RequestQueueClient.is_finished abstract",
  "prBody": "Fixes #1985",
  "patch": "<unified git patch generated against the current master>",
  "draft": true,
  "upstreamIssue": 1985
}
```

`upstreamIssue` is optional, but when supplied it must match the issue number in the title. The payload schema is also checked by `schemas/pr-job.schema.json`; runtime validation is stricter about bytes, control characters, Git refs, patch headers, and sensitive paths.

One relay issue is one job. To submit another contribution, create another relay issue. A failed job can be intentionally retried by adding a `relay/retry` label, but a successful job is always terminal. A retry still cannot overwrite an existing branch or create a duplicate PR.

## Labels and status comments

The workflow creates or reuses:

- `relay/pending`
- `relay/running`
- `relay/success`
- `relay/failed`
- `relay/retry` for an explicit manual retry request

Terminal comments have machine-readable markers such as `<!-- pr-relay-result job=... state=success -->`. Do not edit or copy these markers into the PR body.

Success:

```text
SUCCESS
PR: https://github.com/upstream/project/pull/123
Branch: fix/example
Commit: <40-character SHA>
```

Failure:

```text
FAILED
Stage: patch-validation
Reason: patch is not a unified git diff with a file path and hunk
```

## How ChatGPT should invoke it

Use a single issue per PR. Inspect the upstream repository, issue, base branch, and existing PRs first. Generate a text unified diff against the current upstream base. Then create one issue in `aryansk/pr-relay` with the exact title and JSON-only body above. Never put a PAT, API key, SSH key, or other secret in the issue. Wait for the relay issue's terminal `SUCCESS` or `FAILED` comment before reporting the outcome. Do not create five relay issues in one burst until one complete test has been inspected.

A short reusable prompt is:

> For exactly one already-reviewed open-source fix, create one issue in the private `aryansk/pr-relay` repository. Use title `[pr-relay] <upstream-owner>/<upstream-repo> #<issue-number>` and a body containing only the validated JSON job described in `README.md`. Use a direct `aryansk` fork, a fresh feature branch, a unified text patch, and `draft: true` for the first test. Never include credentials. Wait for the relay issue's terminal status comment and return its PR URL or failure stage.

## Troubleshooting

- **No workflow run:** check that Actions are enabled, `PR_RELAY_ENABLED` is exactly `true`, the issue title starts with `[pr-relay]`, and the event is `opened`, `edited`, `reopened`, or an explicit `relay/retry` label event.
- **Queue returns 401/302 or another non-200 response:** the Vercel `/api/jobs` URL is not publicly readable, is behind deployment protection/SSO, or is redirecting. Make that endpoint genuinely public and read-only, or update the configured public endpoint in the relay. Do not put `PR_RELAY_TOKEN` in Vercel and do not weaken the poller's HTTP-200/redirect checks.
- **Authentication failure:** verify the secret name is exactly `PR_RELAY_TOKEN`, the classic PAT has not expired/revoked, and it has the `repo` scope. Rotate it by creating a replacement, updating the repository secret, then revoking the old token.
- **Repository validation failure:** the upstream must be public, the fork must already exist under `aryansk`, and GitHub's fork metadata must identify that exact upstream as its direct parent.
- **Duplicate-protection failure:** inspect the requested branch and existing PRs. The relay will not overwrite an existing fork branch or force-push it. Use a new branch and a new relay issue only when the existing work is intentionally separate.
- **Patch failure:** generate the diff from a clean checkout of the exact upstream base. Do not include binary changes, symlinks, submodules, workflow files, credential-like paths, or repository automation files.
- **Failure after push:** the relay may have safely pushed a branch before a later API call failed. Inspect GitHub for the branch/PR before retrying; duplicate checks prevent a second PR.

## Rotation and incident response

1. Set `PR_RELAY_ENABLED=false`.
2. Revoke/delete the old classic PAT in GitHub settings.
3. Generate a replacement with the same minimum scope and expiration.
4. Update `PR_RELAY_TOKEN` directly in the repository secret UI.
5. Confirm the variable remains `false`; set it to `true` only after reviewing the replacement and any in-flight runs.

If the relay code itself is suspected of compromise, disable the workflow and revoke the token first. Because the workflow checks out the repository's trusted default-branch code, protect the default branch and review changes to `.github/workflows/pr-relay.yml`, `scripts/relay.mjs`, and the schema before re-enabling it.

## Deliberate limitations

This first version favors fail-closed behavior over maximum patch compatibility. It accepts ordinary text unified diffs only; it does not run tests or builds, handle binary files, modify sensitive paths by default, update existing branches, force-push, merge, approve, or bypass branch protections. GitHub Actions and PR checks remain the source of truth for whether the resulting contribution is correct.
