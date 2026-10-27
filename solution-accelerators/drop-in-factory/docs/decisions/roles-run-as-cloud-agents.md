# Steps run as cloud agents

Each step in `factory.yaml`'s `steps:` list (six by default) is a Cursor cloud agent launched on the run branch `factory/<run>` with `foreman/bot/subagents/<step>/instructions.md` plus the run's context. Foreman is the only BDK agent.

A cloud agent has a full VM, so the factory needs no sandbox, clone, commit or push code of its own: the agent pushes through the Cursor GitHub app, and can use the repository's cloud environment to run tests.

The cost is a VM start per step (a minute or two) and the prerequisites in the README: cloud agents on the plan, the GitHub app with write access, and privacy settings that allow them. The worker checks every finished agent's branch, base commit, changed files and result file, because an agent can push the wrong thing.

Mixing local and cloud steps is not supported, so the worker has one execution path.
