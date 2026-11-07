# Methodology

[conduct/methodology/SKILL.md](conduct/methodology/SKILL.md) is the master copy of the harness. [.cursor/rules/delivery-loop.mdc](.cursor/rules/delivery-loop.mdc) is the Cursor rule. [AGENTS.md](AGENTS.md) points agents at both. [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md) is the code conduct those files reference and do not copy.

Git tags version this copy. A client pins a tag, for example `github:Madmaxme/delivery-loop#v1.0.0`, and adds overlays in its own repo: `delivery-loop.yaml`, the invariants file, and prompt files. The client does not install `main`. Product names stay in the client repo.

`delivery-loop init` and `delivery-loop update` copy the skills, the Cursor rule, and the runner workflow from the pinned package. The runner workflow clones that same tag.

## Engine heal release

An engine heal of this package opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. The opener commits the next patch of `package.json` and `package-lock.json`, computed from the highest `v*` tag, and pushes with the commit-actor token. The first heal after `v1.0.0` is `1.0.1`. If that tag already exists, the opener stops. The workflow does not push a commit. Branch protection on `main` requires a pull request and a green `quality` check, with no approving review. `enforce_admins` stays off.

The `engine-heal` workflow waits until the `pull_request` `quality` check is green on that head, squash-merges, reads the version from the merged `package.json`, and tags that commit `vX.Y.Z`. The tag push is not blocked. A pull request that arrives without the bump gets a comment and stops. A `workflow_dispatch` run does not satisfy the required check, so the workflow does not start one.

## Worker ledger

Every worker workflow writes the run to the owner's ledger before it does its work, then writes again when it finishes. The writer is `scripts/ledger-report.sh`. `quality` does not call it. That check has to stay green or red on the code alone, so a ledger outage cannot block every pull request. Results for pushes to `main` already reach the ledger through the owner's GitHub listener.

The repository secrets are:

- `LEDGER_WEBHOOK_URL`, the HTTPS endpoint that accepts the POST.
- `LEDGER_WEBHOOK_AUTH`, one HTTP header line, such as `Authorization: Bearer ...`.

The script posts JSON. `key` is `gh:<repository>:run:<run id>:<run attempt>:<phase>`. `source` is `engine-heal`, `ci`, or `other`. `repo` is `GITHUB_REPOSITORY`. `subject` is the workflow name, a space, and the event. For `engine-heal`, when the workflow_run payload lists a pull request, the subject ends with ` #<number>`. `link` is `<server>/<repository>/actions/runs/<run id>`. The body also sends `phase` (`started` or `finished`), `status` (the third argument, or empty), `run_id`, `run_attempt`, `workflow`, and `sha`. `sha` is the workflow_run head sha when the event has one, otherwise `GITHUB_SHA`. The event in the subject is the workflow_run's own event when that payload has one, so an engine-heal run records `pull_request` rather than `workflow_run`.

The POST uses `curl --fail-with-body --retry 3 --retry-all-errors --max-time 20`. The script builds the JSON with `jq` when `jq` is on `PATH`, and with bash otherwise. It never prints the URL or the auth header.

An empty secret or a failed POST fails the job. The annotation looks like this:

```
::error title=Ledger write failed::LEDGER_WEBHOOK_URL is empty
::error title=Ledger write failed::LEDGER_WEBHOOK_AUTH is empty
::error title=Ledger write failed::POST failed after retries (HTTP 500)
```

`engine-heal` checks out the repository only so the script is on disk, then reports `started` before Node, install, and the merge script. The last step reports `finished` with `job.status` and `if: always()`. The job `if` still requires a successful `pull_request` quality run. A run that does not match never starts a runner, so it does not write a `skipped` row. A run that starts and then prints `Not an engine-heal merge` exits 0. That row is `started`, then `finished` with status `success`, which is the real job status.

The runner shipped to clients, `templates/runner.yml`, calls the same script only when `LEDGER_WEBHOOK_URL` is set. The call is after the package clone and before `npm install` and `delivery-loop`. An empty URL skips both writes, so a client without the secret is unchanged. A set URL that cannot be written fails the job before the loop runs.
