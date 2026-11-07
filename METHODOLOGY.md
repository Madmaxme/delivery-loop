# Methodology

[conduct/methodology/SKILL.md](conduct/methodology/SKILL.md) is the master copy of the harness. [.cursor/rules/delivery-loop.mdc](.cursor/rules/delivery-loop.mdc) is the Cursor rule. [AGENTS.md](AGENTS.md) points agents at both. [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md) is the code conduct those files reference and do not copy.

Git tags version this copy. A client pins a tag, for example `github:Madmaxme/delivery-loop#v1.0.0`, and adds overlays in its own repo: `delivery-loop.yaml`, the invariants file, and prompt files. The client does not install `main`. Product names stay in the client repo.

`delivery-loop init` and `delivery-loop update` copy the skills, the Cursor rule, and the runner workflow from the pinned package. The runner workflow clones that same tag.

## Engine heal release

An engine heal of this package opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. The opener commits the next patch of `package.json` and `package-lock.json`, computed from the highest `v*` tag, and pushes with the commit-actor token. The first heal after `v1.0.0` is `1.0.1`. If that tag already exists, the opener stops. The workflow does not push a commit. Branch protection on `main` requires a pull request and a green `quality` check, with no approving review. `enforce_admins` stays off.

The `engine-heal` workflow waits until the `pull_request` `quality` check is green on that head, squash-merges, reads the version from the merged `package.json`, and tags that commit `vX.Y.Z`. The tag push is not blocked. A pull request that arrives without the bump gets a comment and stops. A `workflow_dispatch` run does not satisfy the required check, so the workflow does not start one.
