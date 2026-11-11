# delivery-loop

Delivery Loop v2 is an agent-assisted delivery engine for Linear, GitHub, and Jira. Clients pin a package tag and provide project policy, acceptance criteria, and deployment commands in their own repository.

The v2 pack uses `schemaVersion: 2` and requires explicit eligibility, landing strategy, promotion stages, and completion status. The engine supports pull-request or fast-forward landing, runs ordered promotion stages, and records stage-verification receipts in tracker state. `audit` evaluates eligibility without delivery writes; `sweep` is an explicit serial run, not a scheduled job. See [METHODOLOGY.md](METHODOLOGY.md) for the index and [the master v2 procedure](conduct/methodology/SKILL.md) for behavior.

## Install

```bash
npm install -g github:<owner>/<repo>#vX.Y.Z
delivery-loop init --tracker github --eligibility none
delivery-loop update
```

`init` requires an explicit `--eligibility none` or `--eligibility command --eligibility-command <command>` choice; a bare `delivery-loop init` is invalid. For Jira, use `--tracker jira` and explicitly provide `--jira-api-base-url`, `--jira-auth-header-env`, `--jira-intake-jql`, and `--jira-approval-field-id`. The API URL must be HTTPS; credentials stay in the named environment variable.

`init` writes the v2 project pack and installs the canonical `.agents/skills/delivery-loop` and `.agents/skills/delivery-loop-conduct` skills. Cursor and Claude skill entries are symlinks to those canonical directories. `update` refreshes generated skills, the Cursor rule, and runner workflow without changing `delivery-loop.yaml` or the invariants file.

Use `delivery-loop audit` for a read-only eligibility review, `delivery-loop deliver <id>` for one ticket, and `delivery-loop sweep` for an explicitly dispatched intake run. `delivery-loop ship <id>` runs ship-authorized stages; `delivery-loop ship continue <id>` resumes the active ship stage. See the [v1-to-v2 migration guide](conduct/methodology/MIGRATION-V1-TO-V2.md) before upgrading a v1 client; v2 has no v1 pack or run-state compatibility path.

Optional run events are written by `scripts/run-event.sh` and posted only when `DELIVERY_LOOP_EVENT_URL` is set. Credential logs record the slot, endpoint class, and status, never tokens, headers, or request URLs.

Cursor credentials use `workerKeys.primary` and `workerKeys.fallback` (defaulting to `CURSOR_API_KEY` and `CURSOR_API_KEY_FALLBACK`); `workerModel` is optional. UI projects can configure `design.figmaTokenEnv`; the Figma token stays in the environment, not the pack.

Licensed under Apache-2.0. See `LICENSE`.

## Contribute

Clone this repo, branch from `main`, and open a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance. Adapter changes belong in `src/adapters` with tests. The versioned procedure and code-conduct sources are `conduct/methodology/SKILL.md` and `conduct/conduct/SKILL.md`; clients keep project-specific policy and deployment instructions in their overlays.
