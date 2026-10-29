---
name: run-and-report
description: Run generated tests with Jest and publish the result in the pull request. Use after tests are generated, to verify them and to comment on the PR with failures, a short log tail and the agent's edge cases.
---

# Run and report

## How
1. Run only the generated files: `npx jest --runTestsByPath <files>` (config in `jest.config.js`, ts-jest, `*.gen.jest.ts`).
2. Write `pr-report.md`: pass/fail, list of files, the last 60 lines of Jest output, and the "Agent edge cases" list with the reason for each case.
3. Exit non-zero on failure. The workflow then posts `pr-report.md` (or `sanity-report.md` when the precheck failed) as a sticky PR comment with header `agent-tests`, and removes the comment when the run is green.

Implemented in `bot/scripts/pr-tests.ts` (`report()`).

## Rules
- Report generation errors (missing key, bad plan) as failures with the message, never silently.
- Never print secrets. Only the Jest tail and agent notes go into the comment.
- Do not rewrite or delete existing hand-written tests.
