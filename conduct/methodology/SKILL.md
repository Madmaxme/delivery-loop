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

## Install and client overlays

`delivery-loop init` writes a complete v2 pack and installs the canonical `delivery-loop` and `delivery-loop-conduct` skills under `.agents/skills`. Cursor and Claude skill entries are symlinks to those canonical directories. `delivery-loop update` refreshes generated skills, the Cursor rule, and runner workflow; it never edits `delivery-loop.yaml` or the invariants file. An unowned path collision is an error, not permission to overwrite client files.

Client overlays provide project eligibility, ticket authority, acceptance meaning, tracker settings, deployment and environment procedure, and any product-specific restrictions. They may add policy, but do not replace this skill, weaken the explicit audit/authorization gates, or create another orchestration implementation.

See [MIGRATION-V1-TO-V2.md](MIGRATION-V1-TO-V2.md) before upgrading a v1 client.
