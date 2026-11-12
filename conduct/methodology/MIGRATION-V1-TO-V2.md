# Delivery Loop v1 to v2 migration

V2 is a breaking contract change. Stop starting v1 runs, finish or explicitly abandon active runs, and preserve any history the client needs before upgrading. V2 reads only v2 state; it has no v1 pack reader, run-state parser, or alias. `delivery-loop update` refreshes generated files but does not convert `delivery-loop.yaml` or invariants.

## Pack fields

- Set `schemaVersion: 2`.
- Add an explicit `eligibility`: `{ mode: none }` only when the client intentionally has no eligibility command, otherwise `{ mode: command, command: ... }`.
- Set `landingStrategy` to `pull-request` or `fast-forward`.
- Replace the old `dev` and `ship` sections with an explicit ordered `promotionStages` list; use `[]` for a local-only delivery plan.
- Set required `status.complete`. Map old `status.dev` to it for a normal delivery. Map old `status.prod` to `status.shipped` when it represented post-ship completion.
- If any ship stage writes status, set `status.shipped`. V2 removes `status.dev`, `status.prod`, `dev`, and the v1 `ship` configuration.

For old `dev.promote` or `dev.steps`, create one or more `authorization: deliver` stages in their former execution order. Set each stage's opaque `id` and `target`, its repo list, a `promoteCommand`, and a `verifyCommand`. Commands now receive structured JSON on stdin; update old shell commands that depended on `{repo}` substitution or the old argument contract. The verifier must return a complete receipt for the criteria that apply to that stage and the SHAs of repos that stage lists and the ticket landed. A criterion with no stage or repo cell applies to every stage and every landed repo. A stage whose repo list misses every landed repo is not applicable.

For `ship.afterDev: true`, move the old automatic post-dev work into a final `authorization: deliver` stage. When old `ship.markStatus` was true, use the old `status.prod` as `status.complete`; otherwise use old `status.dev`. For manual production steps, add a `authorization: ship` stage after all deliver stages. Map `ship.continue` to that stage's `continueCommand`, `ship.parkSuccess` to `parkSuccess`, and `ship.markStatus` to `writeStatus`. Every ship stage also sets `approval` to `{ source: list, issues: [ids] }` or `{ source: label, label: <name> }`. Any other shape is rejected. `ship`, `ship continue`, and `ship sweep` check that approval before promote or continue, including a `ship-continue` repository dispatch. Before promote or continue, the stage command is called once with `{ phase: "plan" }` and returns `{ carries, untracked }` for the SHA it will promote. An unapproved carried ticket blocks with `approval-missing` and nothing is promoted. Untracked commits are listed and do not block. Plan, promote, verify, and continue receive `releaseSet` and the stage target. Set `status.shipped` when `writeStatus` is true. A ship stage cannot run until every applicable delivery stage has a current passing receipt. `status.complete` and `status.shipped` are written after receipts pass and are not read as proof. Journey proof from `journeyCommand` is a JSON list of `{ repo, path, sha }` checked against `repos[].name` and `journeySpec`. Missing or unavailable proof after land opens one heal and the run exits non-zero. `dependsOn` lists stage ids in the same authorization that must pass, or be not-applicable, first. Stages that do not name each other verify together.

For Jira, supply the client's actual HTTPS REST base URL, authorization-header environment-variable name, intake JQL, and approval field ID. `delivery-loop init --tracker jira` requires explicit `--jira-api-base-url`, `--jira-auth-header-env`, `--jira-intake-jql`, and `--jira-approval-field-id` values; do not guess project metadata or reuse another client's fields. Store secret values only in the environment.

## Run state and verification

V2 adapters persist `DeliveryState` with schema version 2, markers, and stage receipts. V1 comments/markers are ignored. V2 receipts are tied to `criteriaRevision` and the exact landed SHA set; changed ticket criteria invalidate stale work and receipts. Before enabling a migrated pack, validate its explicit choices and run the fake-adapter and stage-verifier tests. Keep client eligibility, Jira policy, product acceptance, deployment details, and environment-specific instructions in that client's overlay.
