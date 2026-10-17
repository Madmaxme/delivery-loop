---
name: conduct
description: Code conduct for every ticket. One code path, evidence before building, a work order that cites an existing invariant, and no one-off patch.
---

# Conduct

Apply this on every ticket.

- One code path. Extend the owner of a behavior. Do not add a second implementation that can disagree with it.
- Evidence before building. A ticket that names a live record or a crash needs that evidence in the audit.
- The work order cites one invariant that already exists in the invariants file. The change keeps that rule true.
- Tests named in the work order must pass before merge.
- A one-off patch that leaves the wrong rule in place is unfinished. Change the owner of the rule.
- Do not invent a product question. Stop with NEEDS DIAGNOSIS, NEEDS RESCOPE, WRONG DIAGNOSIS, or ALREADY SHIPPED when the ticket is not BUILDABLE.
