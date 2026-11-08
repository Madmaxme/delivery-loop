# Bot definitions

This directory is optional and client-agnostic. It holds **role templates**. A client holds **instances** of those roles.

The engine does not name a client, a repository, a bot id, a cloud-agent id, or a secret. An instance file may name a **reference** (`ref:delivery-agent`). The reference is not a platform id. The engine does not look it up.

What the delivery agent can call is taken from the engine. `ForgeAdapter`, `TrackerAdapter`, and `WorkerAdapter` in `src/adapters/types.ts`, the worker and forge implementations, the runner and tracker kinds on the pack, and the read connectors in `src/connectors/catalog.ts` are the source. The loop, engine-heal, and [METHODOLOGY.md](../METHODOLOGY.md) are the source for the merge rules. An inventory row is a cross-check of a role. It is not a source of capabilities. A source that was not read is a coverage gap. It is not dropped.

## Templates and instances

| | Where it lives | What it is |
| --- | --- | --- |
| Role template | This package, `bots/templates/` | The shape and the bounds of a role |
| Instance | The client pack, at `bots.path` | That client's bot, filling the same schemas |

An orchestrator instance belongs to one client. A verdict-writer instance belongs to one client. Each business has its own. A client's delivery-agent instance may be shared across clients if it is the same bot everywhere. The shared instance is still an instance the clients point at. It is not a second template, and it is not a credential.

A GitHub App, or any other identity that opens a pull request, runs a plan, or merges when checks are green, is not an agent and not a role. An agent is a model tied to tools. That app is an execution identity the delivery agent calls. The templates name it with a `ref:`. They do not make it a bot.

`delivery-loop init` does not copy this directory. A client that wants the layer copies `bots/templates/` into its own tree and sets `bots.path` in `delivery-loop.yaml` to that directory, relative to the pack file.

```yaml
bots:
  path: bots
```

When `bots` is absent, the engine does not read a bots directory. Sweep, deliver, ground, and ship behave as they do without this layer.

## What a directory contains

`manifest.yaml` names the files. Every path is relative to the directory. A path that leaves the directory, including through a symlink, is refused.

- `orchestrator.yaml`, `verdict-writer.yaml`, `delivery-agent.yaml`, and `engineering-bot.yaml` are role definitions ([bot-definition-1.0](../schemas/bot-definition-1.0.schema.json)).
- `routines/` holds described routines ([bot-routine-1.0](../schemas/bot-routine-1.0.schema.json)).
- `inventory.yaml` cross-checks the roles and records coverage gaps ([bot-inventory-1.0](../schemas/bot-inventory-1.0.schema.json)).
- `manifest.yaml` ties them together ([bot-manifest-1.0](../schemas/bot-manifest-1.0.schema.json)).

`specversion` is `1.0` on every file. `effect` is `data-only` on the manifest, the definitions, and the routines. Unknown fields are refused. A field that would carry a token, a secret, a password, a cookie, or a platform bot id is refused. Use a reference.

Definitions are data. Loading them does not relax a quality gate, write a status, write a label, merge a pull request, dispatch a run, or grant an authority the engine did not already have. The pack keeps `bots.path`. The delivery loop does not read the bundle. This layer does not install a runtime identity-separation gate. A policy id other than `canonical-call-path` records a bound. The engine does not consult those ids when it merges. `canonical-call-path` is enforced by the adapters. A bot cannot opt out of it.

`bots.path` is relative to the client pack file and must stay inside that file's directory. A `../` step is refused. A symlink whose target is outside that directory is refused. The check is the lexical path and the real path.

Each role definition carries `policies`, an enum of required policy ids. Every role requires `canonical-call-path`. The delivery agent also requires `no-self-merge`, `independent-review`, `checks-on-exact-head`, `head-pinned-squash`, `no-rebase`, and `no-merge-on-red`. The orchestrator also requires `orchestrator-no-dispatch` and `orchestrator-no-status-writes`. The verdict writer also requires `verdict-no-status-writes` and `verdict-no-relax-gate`. The engineering bot also requires `no-self-merge`, `engineering-no-dispatch`, `engineering-no-status-writes`, `engineering-no-relax-gate`, and `engineering-reports-only-to-orchestrator`. Its `reportsTo` value must be the orchestrator role. Each role has its own `may` allowlist. An id that is not on that list is rejected, including an id that is valid for a different role. The sentence text is not the check.

## Canonical call paths

The inventory declares one path per API the bundle uses. The field is `canonicalPaths`. A secret is not stored there. `delivery-loop bots validate` rejects a role that omits `canonical-call-path`, an API the bundle uses with no path, a direct stored key for Linear or GitHub, two GitHub roles that share a source, and two AWS caller classes that share a source. An example inventory is [src/bots/fixtures/canonical-path/inventory.yaml](../src/bots/fixtures/canonical-path/inventory.yaml).

| API | What the path declares | Health check before dispatch |
| --- | --- | --- |
| `linear` | OAuth client credentials or a mint command, refreshed per process. `viewerId` and `organizationId` are the check. `expectedIdentity` is display only. A stored static key is rejected. | `POST https://api.linear.app/graphql` with `{ viewer { id name organization { id } } }`. Status must be 200. |
| `github` opener | Mint per process. `identityKind: user`. `allowedPrincipalIds` are numeric GitHub user ids. | `GET /user`. The numeric id must be one of those ids. The trusted commit-actor id for the repo is checked on every call. |
| `github` merger | An installation token, a different principal from the opener. `appId`, `installation`, and `repository` are required. | `GET /repos/{repository}/installation`. The installation id and app id must match. |
| `aws` | One source for each caller class in use: `agent`, `actions`, `runtime`. The account id and ARN are required. | `aws sts get-caller-identity` with the issued key, secret, and session token. Provider fallbacks are disabled. |
| any other api | An extension. It names a `healthCommand`. | That command must exit 0. |

The CLI order before dispatch is: mint, the Linear viewer check, then each GitHub identity's check. A mint that returns the same value as the stored copy is refused. The comparison stays in memory and the value is not logged. Adapters take only a credential the resolver stamped. Git, `gh`, and AWS child processes drop ambient tokens and receive the stamped credential. The `Authorization` header is exactly one `Bearer` scheme.

## Roles

### Orchestrator

Monitors existing delivery runs and reports evidence.

It does not start, dispatch, re-dispatch, resume, or run the delivery loop. That includes a scheduled sweep and a ground-only compile. It does not write a delivery status or a delivery label. It does not name adapter tools. Those belong to the delivery agent.

### Verdict writer

Records a ground verdict and the evidence that verdict cites.

It does not write a delivery status or a delivery label. It does not start the delivery loop. It does not relax a quality gate or grant authority. It does not name adapter tools.

### Delivery agent

The harness execution agent, and one of the engine's roles. It thinks, then calls tools.

Its tools are the adapter operations:

- Forge: `openPullRequest`, `quality`, `designCheck`, `requestQualityRun`, `mergeability`, `compare`, `updateBranch`, `squashMerge`, `dispatch`. `quality` and `designCheck` take the head sha. A result recorded on another sha is not a result. `squashMerge` takes that same head sha.
- Tracker: `listIntake`, `get`, `comment`, `setState`, `addLabel`, `removeLabel`, `projectSnapshot`.
- Worker: `start`, `join`.
- Connectors: the read connectors named in the catalog. The file stores the name, not an address.

Its identity references are the pack's forge, tracker, worker, and runner kinds, plus `ref:commit-actor` and `ref:merge-review`. `ref:commit-actor` is the login check in `commitActorLogin`. The login is not stored here. `ref:merge-review` is the identity that reads check-runs on the exact reviewed head and squash-merges that head.

An identity that opened or pushed a head does not merge that head. Review is independent of that identity. The merge is a squash of the exact reviewed head, and only when the check-runs on that head are green. There is no rebase. There is no force-merge when a check on the reviewed head is red. A head other than the exact reviewed head is not merged. `updateBranch` is the forge tool the engine uses when a branch is only behind. It is not a rebase, and it is not a merge.

The delivery agent does not relax a quality gate. Stating these tools does not call them.

### Engineering bot

Sits under the orchestrator. The orchestrator talks to the user and hands this role a scoped engineering task. This role does not talk to the user.

It takes that task, carries it out with its skills and tools, and returns a structured result to the orchestrator: the outcome, evidence links, and what is unverified. `reportsTo` is `orchestrator`.

The allowed work follows the adapters. `ForgeAdapter.openPullRequest` opens a pull request. `WorkerAdapter` `start` and `join` are how a branch, a commit, and a test run are described. It does not call `ForgeAdapter.squashMerge`, so it does not merge its own pull request (`no-self-merge`). It does not call `ForgeAdapter.dispatch`, and it does not start or run the delivery loop (`engineering-no-dispatch`). It does not call `TrackerAdapter` `setState`, `addLabel`, or `removeLabel` (`engineering-no-status-writes`). It does not relax a quality gate (`engineering-no-relax-gate`). It does not talk to the user or to anyone else except by returning the result to the orchestrator (`engineering-reports-only-to-orchestrator`).

Its `may` allowlist is `engineer-task` and `report-to-orchestrator`. It does not name the delivery agent's tool surface. Stating the work does not start it. The role is optional. A manifest may omit `engineering-bot`. The other three roles stay required, and that bundle validates as it did before this role existed. When `bots.path` is absent, nothing reads this file.

## Routines

A routine file is a description. It has a trigger spec, inputs, an output event contract, an idempotency rule, an overlap policy (`skip`, `queue`, or `refuse`), and an approval boundary. The trigger kind is `event`, `schedule`, or `webhook`. Nothing in this package registers that trigger. `delivery-loop bots validate` does not schedule it either.

The templates are:

- `routines/github-events.yaml` describes forge events that already happened.
- `routines/ledger-reconcile.yaml` describes a comparison of recorded run events with runs already visible.
- `routines/worker-webhook.yaml` describes a worker callback. It has no address and no header.
- `routines/proactive-check.yaml` describes a read of runs that are already open.
- `routines/inactivity-check.yaml` describes a report of runs with no new evidence. It does not resume them.

Input `source` values are references (`ref:open-runs`), not credentials.

## Inventory

The inventory lists the four roles and nothing else. An execution identity is not a role row.

Each role row has:

| Field | Meaning |
| --- | --- |
| `id` | The role slug. Not a platform id. |
| `platform` | Where an instance runs. Templates say `unspecified`. |
| `purpose` | What the row cross-checks. |
| `identityRef` | A `ref:` name. Not a bot id, not a secret. The engine does not dereference it. |
| `verification` | `verified` or `unverified`. |
| `evidence` | A location. The engine does not open it. |
| `observedAt` | UTC time the row was observed, `YYYY-MM-DDTHH:MM:SSZ`. |

A template row is `unverified` because it is not a live instance.

`coverageGaps` is required. A source that was not read is recorded there, with `status` `unreached` or `unverified`, a `reason`, and `observedAt`. An empty list means the author claims there is no such source. Omitting the section is invalid. The template records three generic gaps: no bot listing was read, no trunk was read, and no live inventory was compared with the adapters. A client instance uses the same shape for a listing it could not read or a trunk it could not read. It does not name those sources by dropping them.

`delivery-loop bots list` prints the role rows and the coverage gaps. It does not print tools, identities, or authority.

## Commands

```bash
delivery-loop bots validate
delivery-loop bots list
```

Both read the pack in the working directory, or `--dir`. Both refuse to run when `bots.path` is unset, and they do not look for a default directory. Validate checks versions, references, the adapter surface, and coverage gaps. List prints the inventory. Neither command reads a credential, uses the network, writes a file, dispatches a run, or schedules a routine.
