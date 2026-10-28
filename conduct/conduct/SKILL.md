---
name: conduct
description: Universal code conduct for every install. One code path, evidence before building, a work order that cites an existing invariant, and no one-off patch. The install owns type safety and named sources of truth.
---

# Conduct

The runner prepends this file to every ground and build prompt. An install does not replace it.

- One code path. Extend the owner of a behavior. Do not add a second implementation that can disagree with it.
- If a behavior already has an owner, every caller uses that owner. Change that owner first. Repeating the rule in a screen, a default argument, or another constant is unfinished. The subject does not matter.
- A measure the owner does not claim stays separate. A change that belongs in one place does not get a new shared owner.
- When extending an owner, include the remaining callers that still do the old behavior, or name a category exclusion.
- Evidence before building. A ticket that names a live record or a crash needs that evidence in the audit.
- The work order cites one invariant that already exists in the install's invariants file. The change keeps that rule true.
- Tests named in the work order must pass before merge. The install's quality check must be green.
- A one-off patch that leaves the wrong rule in place is unfinished. Change the owner of the rule.
- Do not invent a product question. Stop with NEEDS DIAGNOSIS, NEEDS RESCOPE, WRONG DIAGNOSIS, or ALREADY SHIPPED when the ticket is not BUILDABLE.
- A BUILDABLE audit says `**Prior request:** none`, `kept`, `replaced <id>`, or `ask`. `none` means no written rule asked for the current behavior. `kept` means one did and this ticket keeps it. `replaced <id>` means this ticket undoes that request and names it. `ask` means a rule asked for the current behavior and this ticket does not undo it. `ask`, a missing line, or `replaced` without an id does not build. The verdict stays BUILDABLE. Look only at the install's invariant and decision documents and at commit subjects that already name a ticket. No sentence means `none`.
- A BUILDABLE audit says `**Outside grant:** none` or `open`. `none` means the done-state is code this repository can land. `open` means the done-state is something this repository cannot obtain: a vendor approval, an account only a person can create, or an engine this repository does not own. Build the owned code either way. `open` does not mark the ticket dev-done, so anything blocked by it stays blocked. Reading a vendor's documentation is not that grant.
- A BUILDABLE audit says `**Journey evidence:** recorded`, `not-applicable`, or `blocked`. `not-applicable` means the done-state is not a journey a person walks. `recorded` means it is, and the handoff names `**Journey proof:**` in backticks. A web journey cites an https recording or screenshot URL that also appears in the build receipt. A mobile journey cites a route test, `repo/path_test.dart` or `repo/path.test.ts`, that is on the merged commit. A sentence with no token is not proof. `blocked`, or a missing line, does not build and does not mark the ticket dev-done.

The install owns the concrete proof: end-to-end type safety, which file is the source of truth, when a module should split, and making a shared primitive safe for every caller before the feature uses it. Those rules live in the install's invariants and prompt files.
