# Status reporting rules

Applies whenever development status, progress, or completion is reported to the operator. A single factual answer to a narrow question is not a status report and does not need a diagram.

## The diagram is mandatory

- Report status as an inline diagram rendered in the conversation, not as a prose list and not as a file to open. The operator asked to see progress; an artifact they have to download is not compliance.
- One diagram per end of the monorepo. `udone` and `admin` never share a diagram. Shared facts (branch, release manifest, cross-end contracts) belong in the text below the diagrams.
- The diagram follows the current IDE theme: light surfaces with dark text under a light theme, and the reverse under a dark theme. Text must stay readable in both.

## Every item carries one of four states

| State                 | Meaning                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| Delivered, verified   | Committed, and the named gate was actually run and its result observed. |
| Delivered, unverified | Committed, but the gate could not be run in this environment.           |
| In progress           | Uncommitted, or committed but plainly incomplete.                       |
| Not started           | No commit, no code.                                                     |

- Never render an unverified item in the same visual language as a verified one. If the difference lives only in the caption, the diagram is lying.
- Do not invent a completion percentage across a task list that has no agreed weighting. Count items or show states; do not average impressions.
- An empty or scaffolded module is reported as scaffolded. A template that came from upstream is not "progress on our features".

## Numbers come from output observed this session

- Test counts, gate results, migration counts, assertion counts, commit ids, and bundle sizes are read from commands run in the current session. Do not recall them from earlier in the conversation.
- A check that was not run is reported as not run. It is never reported as passing, and it never appears as a green node.
- If one run disagreed with later runs — an intermittent failure — say so, with both counts. Smoothing it into "all green" destroys the only evidence that it happened.
- Known defects that were deliberately left unfixed belong on the diagram as unresolved, not omitted. The operator needs to see the outstanding risk where the progress is shown, not only at the end of a paragraph.

## The task board is the single ledger for work items

The HTML board at `D:/MYC/Coding/XW-ERP/dev-board.html` (outside this repository, not version-controlled) is the authoritative list of work items for both ends. The conversation summarises; the board records.

- **Register before starting.** A task that is not on the board does not get worked on. Adding it means: id, title, one-line description carrying the current evidence, `versionId`, priority, tags.
- **Move the state in the same step.** `todo` → `in_progress` when the first line of code is written, `done` only after the commit exists and the named gate was actually run. On `done`, put the commit hash and the measured numbers into `desc`.
- **Bump `SEED_VERSION` with every edit.** The board keeps a copy in `localStorage` and only replaces it when the seeded version is newer. Editing the seed without bumping the version means the operator keeps looking at stale data while the file looks correct.
- **Do not invent dates.** Tasks without a committed schedule keep empty `start`/`end`; the Gantt is not a forecast.
- **Blocked is a state, not a footnote.** Use `blocked` and write the unlocking condition in `desc`, so the dependency is visible where the status is.

A "done" claim in the conversation that the board does not show is a reporting defect; fix the board first, then speak.

## Prohibited

- A status report with text only, when the report has more than one work item.
- A single diagram covering both ends.
- An unverified item styled as complete.
- A percentage not computed from counted, equal-weight items.
- Deck-style imagery: gradients, shadows, decorative icons, or any element that exists to look impressive rather than to carry a state.

The text that accompanies the diagram follows the handoff rules in [`../AGENTS.md`](../AGENTS.md): changed files, actual validation, remaining uncertainty, next steps. Diagram and text are complementary — the diagram carries state, the text carries reason and risk. Neither replaces the other.
