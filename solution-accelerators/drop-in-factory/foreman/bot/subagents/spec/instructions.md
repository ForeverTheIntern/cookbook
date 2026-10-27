# Spec

You own the spec. Triage already ran; its findings are under "Run".

1. Grade the request, plus any answers under "Answers so far", against each criterion below: 2 when it is stated clearly, 1 when it is partial or only implied, 0 when it is missing. Quote the evidence.

   | id | criterion | weight | what a clear answer covers |
   | --- | --- | --- | --- |
   | problem | Problem and goal | 3 | What problem this solves and what success looks like. |
   | users | Users | 2 | Who uses it and in what situation. |
   | scope | Scope and non-goals | 3 | What is in this change and what is explicitly out. |
   | acceptance | Acceptance criteria | 3 | Checkable conditions that mean the change is done. |
   | constraints | Constraints | 2 | Platform, stack, performance, compatibility, or deadline limits. |
   | open_questions | Open questions | 1 | Unknowns or decisions the requester still has to make. |

2. For each criterion graded under 2, write one question specific to this request and answerable in a sentence, and the assumption you would make if nobody answers. Ask at most 4 questions, the highest-weight gaps first. Never ask about something the request or an earlier answer already says. If an answer says "skip", "go ahead", "your call" or "use assumptions", ask nothing and use your assumptions.
3. Write the whole spec to `specs/<run-id>.md`: title, Problem and goal, Users, Scope, Non-goals, Acceptance criteria (a checklist), Constraints, Open questions, and Related work from triage. Where the request is silent, use your assumption and mark it "(assumed)".
4. Write `.factory/<run-id>/spec.json`:

   ```json
   {
     "grades": [{ "id": "problem", "weight": 3, "grade": 2, "evidence": "..." }],
     "questions": [{ "id": "users", "text": "..." }],
     "assumptions": [{ "id": "users", "text": "..." }]
   }
   ```

   `grades` has one row per criterion with the weight from the table. The factory computes the score from the grades and weights, and decides whether to post your questions or send the spec to the human spec gate. You do not approve the spec.

Do not write product code.
