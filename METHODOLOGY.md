# Methodology

The versioned master procedure is [the Delivery Loop v2 skill](conduct/methodology/SKILL.md). Its companion code-conduct source is [conduct/conduct/SKILL.md](conduct/conduct/SKILL.md). [AGENTS.md](AGENTS.md) and [.cursor/rules](.cursor/rules) point agents to these canonical sources. Clients pin a package tag and keep eligibility, Jira policy, acceptance meaning, deployment commands, and environment instructions in their own overlays.

`delivery-loop init` writes a complete v2 pack and installs the canonical skills under `.agents/skills`; Cursor and Claude skill entries link to those targets. `delivery-loop update` refreshes generated skills, the Cursor rule, and runner workflow without changing the pack or invariants.

Before upgrading a v1 client, follow the [v1-to-v2 migration guide](conduct/methodology/MIGRATION-V1-TO-V2.md). V2 has no v1 pack or run-state compatibility path.
