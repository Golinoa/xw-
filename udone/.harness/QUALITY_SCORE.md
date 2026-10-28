# Quality and review standard

Review changes for correctness, authorization, tenant isolation, financial invariants, auditability, migration safety, and user-visible error handling. Keep the patch scoped and preserve unrelated work.

## Required evidence

- Behavior changes: focused tests for changed rules and affected failure cases.
- API changes: request validation, authorization, tenant scope, and compatibility review.
- Schema changes: forward migration review and safe deployment/rollback implications.
- Frontend changes: loading, empty, error, permission, and destructive-action states.
- Release claims: cite actual target-environment build, integration, E2E, concurrency, and recovery evidence.

## Coverage threshold

No repository-wide coverage threshold is adopted. CI runs `pnpm test` but does not publish or enforce a percentage; review changes against the P0 scenario list in `Docs/REQUIREMENTS.md` until an evidence-backed coverage scope and metric are approved.

Never claim tests passed unless they were run and their result observed.

Test levels, risk scenarios and current coverage limits are detailed in [testing standards](TESTING_STANDARDS.md). Local and future CI gates are described in [engineering standards](ENGINEERING_STANDARDS.md).
