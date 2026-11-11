---
name: delivery-loop
description: Delivery Loop v2 orchestration policy. Defines explicit eligibility, ordered promotion stages, exact-SHA verification, state persistence, audit, and ship continuation. Clients pin a tag and add policy overlays.
---

# Delivery Loop v2

This is the versioned, client-neutral orchestration procedure. A client pins one package tag and keeps its product policy, Jira configuration, acceptance meaning, deployment commands, and environment-specific instructions in its own repository. Never infer those values from another client or from a target name.

The companion `delivery-loop-conduct` skill supplies code-conduct rules. The engine owns tracker state transitions and delivery state; workers do not call tracker, forge, deployment, or status APIs directly.

## Required client choices

`delivery-loop.yaml` is schema version 2. It explicitly declares `schemaVersion: 2`, `eligibility`, `landingStrategy`, `promotionStages` (including an empty list), and `status.complete`. The loader rejects missing required v2 choices and v1 promotion fields; it does not translate or default them. `status.shipped` is required when a ship-authorized stage is allowed to write it.

Eligibility is either `{ mode: command, command: <client policy> }` or `{ mode: none }`. `none` is an explicit client decision, not a default. A command receives one normalized ticket as JSON on stdin and must exit successfully with one valid JSON result: `eligible`, `blocked`, or `already-complete`, with a reason code and reason. A failed command or invalid result is a policy error and does not start a worker or perform tracker, Git, forge, promotion, or deployment writes.

`landingStrategy` is `pull-request` or `fast-forward`. `promotionStages` is an ordered list whose `id` and `target` are opaque strings. IDs and targets are unique; all `deliver` stages precede all `ship` stages. An empty list is an explicit local-only plan. The engine does not branch on names such as `dev`, `qa`, or `prod`.

## Commands and authority

- `audit` lists the configured intake and evaluates eligibility only. It does not start workers or call tracker state/comment/label writes, Git writes, forge writes, promotion, or ship operations.
- `deliver <id>` runs one eligible ticket through grounding, build, landing, and every delivery-authorized stage in configured order.
- `sweep` is the explicit serial intake delivery command. It is not scheduled. The runner is explicitly dispatched; do not add cron or other scheduled triggers.
- `ship <id>` runs only ship-authorized stages, and only after `status.complete` and current passed receipts for every delivery stage. `ship continue <id>` resumes the active ship stage with its configured `continueCommand`; it does not restart delivery or choose a stage by target name.

The engine writes `status.complete` only after all delivery stages pass. It writes `status.shipped` only after all ship stages pass and only when a stage has `writeStatus: true`. A blocked or parked receipt does not complete delivery. A parked ship stage exits successfully only when that stage sets `parkSuccess: true`; it never writes `status.shipped`.

## Landing and stage verification

For `pull-request`, the lander verifies the required quality check and lands the candidate through the configured forge path. For `fast-forward`, quality runs on the candidate branch before a non-force fast-forward land; the expected branch head and base SHA are checked so a stale candidate or concurrent trunk update is not overwritten. Promotion begins only from the exact landed commit set.

For each stage and repository, `promoteCommand` receives one JSON input containing the ticket ID, stage ID, opaque target, repository name, and source SHA. After promotion, `verifyCommand` receives one JSON input containing the ticket ID, stage ID, target, current criteria revision, all landed SHAs, and the complete acceptance matrix. It must print exactly one JSON `StageVerificationReceipt` with `stageId`, `target`, `outcome`, `reason`, `criteriaRevision`, `deployed`, and `criteria`.

A passing receipt must identify the exact stage and target, the current criteria revision, the exact landed commit set, and every acceptance-criterion ID with verified evidence. A blocked or parked receipt needs a reason. Invalid, incomplete, stale, or mismatched receipts fail closed. Stages run in list order; a failed or non-passing stage prevents later stages from running.

The worker's acceptance matrix is grounded once as ordered criteria with stable IDs, text, and source. Build and stage verification reuse those IDs and text; clients own the product meaning of each criterion. Do not replace criterion-level proof with a health check or a general claim that the deployment succeeded.

## State and criteria changes

Every tracker adapter provides a v2 `stateStore` for `DeliveryState { schemaVersion: 2, markers, stageReceipts }`. Linear and GitHub persist it as a hidden `delivery-loop-state:v2` base64url JSON comment; Jira uses the `delivery-loop.state.v2` issue property. V1 run-state comments and markers are not read or migrated by the engine. Drain or explicitly abandon active v1 runs before upgrading.

The state store holds resumable work markers, the active promotion stage, landed SHAs, and stage receipts. Receipts are valid only for the current ticket `criteriaRevision`; when criteria change, stale work-order state and receipts are invalidated before continuing. A Jira status transition re-reads the issue and refuses to write if its criteria revision changed. Jira comments remain for user-visible blocker or product-decision messages, not Delivery Loop's run-state store.

Missing recorded journey proof after landing blocks completion. Evidence must come from the original build receipt or a client-owned verifier; the engine does not start a generic worker to capture missing proof. An existing validated `proof-receipt` marker may be reused only when bound to the current criteria revision and exact landed SHAs. Route-test proof is checked on the exact landed commit and configured delivery-stage refs only after the corresponding current stage receipts pass. Do not write journey run state to Jira comments.


## Install and client overlays

`delivery-loop init` writes a complete v2 pack and installs the canonical `delivery-loop` and `delivery-loop-conduct` skills under `.agents/skills`. Cursor and Claude skill entries are symlinks to those canonical directories. `delivery-loop update` refreshes generated skills, the Cursor rule, and runner workflow; it never edits `delivery-loop.yaml` or the invariants file. An unowned path collision is an error, not permission to overwrite client files.

Client overlays provide project eligibility, ticket authority, acceptance meaning, tracker settings, deployment and environment procedure, and any product-specific restrictions. They may add policy, but do not replace this skill, weaken the explicit audit/authorization gates, or create another orchestration implementation.

See [MIGRATION-V1-TO-V2.md](MIGRATION-V1-TO-V2.md) before upgrading a v1 client.

A Figma frame URL is the `figma.com` address. Surrounding markdown and a trailing `)` `]` `>` `.` `,` `;` or quote are not part of it. `node-id=1-2` is read as `1:2`. A 400 includes Figma's `err` or `message` and stops as a rejected request. A 403 or 404 stops as access and names `design.figmaTokenEnv`. The token, the headers, and a URL that contains a token are not written.

Each credential call logs its slot, endpoint class, and status, success included. A re-mint near expiry adds `refresh=1`. The run ends with a count by slot, endpoint class, and status. The token, the headers, and the request URL are not written. A worker launch that succeeds logs `status=200`. A launch that fails without an HTTP status logs `status=0`. `workerModel` is the cursor model id. The launch passes `{ id }` and the credential line names that id. An absent `workerModel` omits the model and logs that the account default is in use. A 5xx on a cursor launch waits one second and retries that slot once. A second 5xx uses the fallback slot. A recorded proof that passes, a promote or ship command that exits 0, and a squash that returns a commit each write one success line.

`worker: http` posts that same prompt to `workerHttp.startUrl` with an id the loop generates, and `model: { id }` when `workerModel` is set. Without `workerHttp.statusStore`, it reads `workerHttp.statusUrl`, replacing `{id}`, every `workerHttp.pollMs` until the status is `finished` or `failed`, or `workerHttp.maxWaitMs` passes. With `statusStore`, the loop writes `{"status":"pending","id","repoUrl","baseRef","requestedAt"}` through the forge before start, creating `branch` from the default branch when it is missing, and reads that file the same way. The credential is the minted token, or the forge token when the mint command is unset. A non-2xx seed fails the worker and does not start. `workerHttp.request` replaces `startUrl`: the loop opens one forge issue titled `worker-request <id>` whose body is a fenced JSON block of the start record plus `requestedBy`, then assigns `assignee`. A block longer than 65536 characters is stored beside the pending file and the issue body is only that path. A non-2xx issue create or assign fails the worker and does not start another launcher. Those calls log `endpoint=worker-request-issue` and `endpoint=worker-request-assign`. The defaults are 15000 and 3600000. `maxWaitMs` stays inside the hosted job budget of 360 minutes. `pending` and `running` are not terminal. A non-2xx start fails the worker and does not start another launcher. Header maps name an env var, or the source `mint` or `gh-token`. Start logs `endpoint=worker-http-start`. Status logs `endpoint=worker-http-status`. A seed logs `endpoint=worker-http-seed`. A spent wait fails the worker with detail `http worker join exceeded maxWaitMs`.

## Promote and ship

`deliver` and `sweep` run all configured delivery-authorized stages in order. `ship <id>` and `ship continue <id>` run only ship-authorized stages after delivery completion and current delivery receipts. Each verifier returns a complete receipt bound to its exact stage, target, criteria revision, landed SHAs, and acceptance IDs. A blocked or parked receipt prevents completion; a parked ship stage succeeds only when `parkSuccess: true` and never writes `status.shipped`. Exit 75 or a non-zero result with `delivery-loop transient <reason>` retries the stage's promote, verify, or active continue command within `transient.maxAttempts` (default 3) and `transient.maxWaitMs` (default 60000), using one-second waits that double. Exhaustion reports the stage failure to the regular heal flow.

## Self-heal

A ship-stage promote, verification, or continue failure uses the same heal path after any configured transient retries. A note or a side watcher is not the fix.

When the owner is this package, the edit opens a pull request on `engine-heal/<ticket>` with the `engine-heal` label. Routine heals use the next patch after the highest `v*` tag; `engineHealBumpVersion` remains patch-only. The planned v2.0.0 release is the separately authorized greater-version bump over main's current package version, not output from the routine helper. The opener commits `package.json` and `package-lock.json` and pushes with the commit-actor token. The `pull_request` quality check gates that head. Only the engine-heal workflow squash-merges and writes the tag and GitHub release. A pull request without a greater version gets a comment and stops. Clients pin the tag when they need the change.

Each failure type has a cap. The default is 3. `heal.maxAttempts` changes the default. `heal.caps.<type>` overrides one type. The count is the `OWNER_HEAL` comments of that type on the ticket, so it survives the next run. At the cap the engine writes the labels and the exhausted comment and stops. A failed write of the `OWNER_HEAL` comment fails the heal. The attempt is not counted, so the cap cannot be skipped by ignoring that error.

```yaml
heal:
  maxAttempts: 3
  caps:
    quality-red: 3
    merge-conflict: 3
    promote-failed: 3
    ship-failed: 3
    quality-pending: 3
    quality-unscheduled: 3
    runner-blocked: 3
```

## What a client adds

The client keeps `delivery-loop.yaml`, the invariants file, and its prompt files. `delivery-loop init` and `delivery-loop update` refresh skills, the Cursor rule, and the runner workflow from a pinned tag. They leave the project file and the invariants file alone. An overlay may add a rule. It does not replace this skill or the conduct skill.
