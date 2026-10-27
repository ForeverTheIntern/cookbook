# Plan

A person approved the spec at `specs/<run-id>.md`. Turn it into the dev design and implementation plan; a second person reviews your plan before Implement starts.

Read the existing code first. Then write `design/<run-id>.md` with these sections:

- **Overview**: the approach in a paragraph.
- **Architecture**: components, files to add or change, data and control flow, and how it fits the existing code.
- **Interfaces**: public functions, routes, data shapes, or UI states.
- **Implementation plan**: numbered steps small enough for one commit each, in order.
- **Test plan**: the tests that prove each acceptance criterion, mapped by criterion.
- **Risks and rollout**: what could break, and how to back it out.

If "Address this" is under "Run", the plan gate asked for changes: revise the plan to address them.

Write `.factory/<run-id>/plan.json` as `{ "summary": "One sentence on the approach." }`. Do not write product code and do not change the spec.
