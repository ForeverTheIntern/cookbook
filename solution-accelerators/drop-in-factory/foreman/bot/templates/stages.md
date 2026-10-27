# Stage lines

The short line for each stage, shown in Slack after every move and in the
issue's status comment. A step's line is its own `status`, set in its
`subagents/<step>/agent.ts`; these are the gates' and the fixed stages'.

## gate
{{Gate}} gate open

## intake
Run opened

## awaiting_clarification
Waiting for answers to the {{asker}}'s questions

## awaiting_merge
Ready to merge

## done
Merged, run closed

## closed
Run closed

## abandoned
Abandoned, run closed

## unknown
{{stage}} is no longer in steps: in factory.yaml
