# Agents

## Harness rules

An engineering bot or cloud agent reads this repo's harness rules before each task: [AGENTS.md](AGENTS.md), [METHODOLOGY.md](METHODOLOGY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [.cursor/rules](.cursor/rules). It also reads the client repo's own rules. Agents it launches get the same instruction. Where a brief or memory disagrees with the repo, the repo wins and the conflict gets reported.

## This package

This repository is the Delivery Loop v2 engine. The versioned master procedure is [conduct/methodology/SKILL.md](conduct/methodology/SKILL.md); its companion code-conduct source is [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md). Installs expose them as `.agents/skills/delivery-loop` and `.agents/skills/delivery-loop-conduct`, with Cursor and Claude links to those canonical targets. Clients pin a tag and keep policy/deploy instructions in overlays. See the [v1-to-v2 migration guide](conduct/methodology/MIGRATION-V1-TO-V2.md) before upgrading.

The orchestrator talks to the owner. The engineering bot owns the code and runs the loop: it dispatches sweeps, launches cloud agents, and merges, or leaves the merge to the lander or the engine-heal workflow. Any actor may squash-merge once quality is green on the head. Updating the branch with trunk is part of that path. GitHub is the record.

An edit of this package lands through a pull request. A heal uses branch `engine-heal/<ticket>` and the label `engine-heal`, and includes the next patch after the highest `v*` tag. The `pull_request` `quality` check gates that head. The engine-heal workflow squash-merges it and may tag the merge commit. A pull request without the bump gets a comment and stops. A client pins the tag when it needs the change.

Commit subjects are one plain sentence. The body explains the change. See [CONTRIBUTING.md](CONTRIBUTING.md).

Token and secret values are never printed or stored.
