---
name: analyze-pr-changes
description: Decide which files in a pull request need unit tests. Use at the start of the PR workflow to list changed frontend/backend source files and skip files that should not get generated tests.
---

# Analyze PR changes

Goal: produce the list of source files worth testing, and say why the others are skipped.

## How
1. List changed files: `git diff --name-only --diff-filter=AM $BASE_SHA...HEAD` (added or modified only).
2. Keep a file only if all of these hold:
   - it is under `frontend/` or `backend/` and ends in `.ts` or `.tsx`;
   - it is not a test, spec, `.d.ts`, generated file (`*.gen.jest.ts`, `generated/`) or inside `node_modules`;
   - it still exists on the PR branch.
3. Skip the file when it has no exported functions, because there is nothing to call. Report that as "nothing to test".
4. Skip the whole run when no file is left. Report that as success.

Implemented in `changedFiles()` in `bot/scripts/pr-tests.ts`. Set `CHANGED_FILES=a.ts,b.ts` to override the git diff for local runs.

## Output
A list of absolute paths passed to the `generate-native-tests` skill.
