# Agent guide

## Mandatory journal

Before ending every task, write `.harness/journal/YYYY-MM-DD-short-task-summary.md` with exact sections: `今日完成`, `关键决策`, `遇到的问题`, `下一步计划`. Use client date. For multi-day work, add one entry per day.

## Role and evidence

Work on **有单·旅游管理系统** and its replication research. Distinguish repository-verified facts, target-site wire evidence, target-site UI/readback evidence, proposals, and unresolved questions. Preserve dates/confidence when copying evidence. Never invent target behavior, API fields, schema, or acceptance results.

## Startup sequence

1. Read this guide and root `ARCHITECTURE.md` before code or architecture changes.
2. Read `.harness/PROJECT_STRUCTURE.md` for directory ownership and `.harness/DOCUMENT_MAP.md` for document sources/lifecycle.
3. Read applicable `.harness` rules: `ENGINEERING_DESIGN.md`, `CODE_STANDARDS.md`, `API_STANDARDS.md`, `DATABASE_STANDARDS.md`, `TESTING_STANDARDS.md`, `ENGINEERING_STANDARDS.md`, `FRONTEND.md`, `SECURITY.md`, `RELIABILITY.md`, `QUALITY_SCORE.md`. For visual work, also read root `DESIGN.md` and finalized rules it links to.
4. Read relevant product/design indexes and active plans. For research, use `.harness/docs/references/research-index-llms.txt` then verify cited originals.
5. `.harness/docs/generated/db-schema.md` is generated: edit migration sources, never hand-edit the report. The current inventory is stale until reproducibly regenerated from `supabase/migrations/`.

## Working constraints

- Inspect current implementation and relevant evidence first. Preserve unrelated WIP and keep changes within requested scope.
- Follow directory ownership and placement rules in `.harness/PROJECT_STRUCTURE.md`. Update the map when a new top-level directory or materially different module boundary is introduced.
- Page styles, shared visual components, and tokens follow root `DESIGN.md` and approved `.harness/Design-system/` Markdown. Drafts belong in `.harness/design-drafts/`; only promote when the user confirms or delegates finalization.
- For behavior changes, identify affected layers and follow `ARCHITECTURE.md`. Validate claims; static checks alone do not prove production readiness.
- Do not expose secrets or real personal/financial data in logs, examples, tests, research artifacts, or journals. Irreversible external actions require explicit authorization.
- Preserve source documents, evidence, valid plans, decision history, and journals. Do not clean/overwrite unrelated files or generated outputs.
- Do not add a dependency or script just for a one-off summary; check links when moving/copying docs. If a source, decision, or environment is missing, record the blocker and continue only with independent work.

## Handoff

Summarize changed files, actual evidence/validation, remaining uncertainty, and next steps. Do not claim checks that were not run. Do not mark a plan complete merely because it moved to `completed/`; deployment gates remain active until proven.

## Superpowers skill selection

Choose skills for their specific value; do not default to the full workflow. Platform/skill mandatory triggers and explicit user requests take precedence.

- Question, explanation, read-only lookup: no workflow skill unless a named skill directly helps.
- Small reversible edit: use only the directly relevant skill.
- Behavior change: use brainstorming when shaping is needed; TDD for behavior implementation; systematic debugging for failures. Add only distinct needs.
- Multi-step change/subsystem/architecture: use brainstorming, then writing-plans as appropriate. Use subagents only when independent work exists and delegation is requested or permitted. Select one execution method.
- Completion claims requiring fresh evidence: use verification-before-completion. Use branch-finishing only when integration disposition is in scope.

Reassess if scope grows. A selected skill does not waive its hard gates. User, platform, and safety instructions take precedence over project guidance.
