# Methodology

[conduct/methodology/SKILL.md](conduct/methodology/SKILL.md) is the master copy of the harness. [.cursor/rules/delivery-loop.mdc](.cursor/rules/delivery-loop.mdc) is the Cursor rule. [AGENTS.md](AGENTS.md) points agents at both. [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md) is the code conduct those files reference and do not copy.

Git tags version this copy. A client pins a tag, for example `github:Madmaxme/delivery-loop#v1.0.0`, and adds overlays in its own repo: `delivery-loop.yaml`, the invariants file, and prompt files. The client does not install `main`. Product names stay in the client repo.

`delivery-loop init` and `delivery-loop update` copy the skills, the Cursor rule, and the runner workflow from the pinned package. The runner workflow clones that same tag.

## Engine heal release

An engine heal of this package opens a pull request on `engine-heal/<ticket>` with the label `engine-heal`. The workflow does not push a commit to `main`. Branch protection on `main` requires a pull request and a green `quality` check, with no approving review. `enforce_admins` stays off. A direct push of the version bump is rejected, because that new commit has no successful `quality` check.

The `engine-heal` workflow commits the patch bump of `package.json` and `package-lock.json` onto the pull request. It waits until `quality` is green on that tip, squash-merges, and tags the merge commit `vX.Y.Z`. The tag push is not blocked. The first heal after the `v1.0.0` tag is `v1.0.1`.

A push from `github-actions[bot]` does not start `on: push` workflows, and the `pull_request` run it would create waits for a person to approve it. The workflow starts `quality` on the bumped tip with `workflow_dispatch` and waits for that run. The check name is still `quality`.
