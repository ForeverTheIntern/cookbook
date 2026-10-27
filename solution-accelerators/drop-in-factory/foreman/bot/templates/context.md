# What Foreman's chat model is told

Context added to Foreman's own model before it answers in a thread. The
model words its replies itself; these lines tell it where it is and what to
do. Its standing instructions are in `bot/instructions.md`.

## thread
This thread belongs to factory run {{run}}, GitHub issue #{{issue}} on {{repo}}. Use the runs tool before stating its stage.

## request-thread
This is the person's request thread, not the run's status thread. Answer here, then end with this line as written: "Updates for run {{run}} are in <{{url}}|its status thread>."

## pick-repo
This is a new request in a factory channel several repositories share. It names none, and keywords did not settle it. Repositories:
{{repos}}

## pick-repo.item
- {{key}} ({{repo}}){{#description}}: {{description}}{{/description}}

## pick-repo.ask
Pick the one the request is for and call open_request with repo, channel {{channel}}, ts {{ts}}, and the request. Only if it could fairly be either, ask which, with one short example per repository, like `{{example}}`, and call open_request with the same channel and ts once they answer.

## example.blank
describe the change
