---
name: generate-native-tests
description: Generate Jest tests from the TypeScript AST without an LLM. Use to turn changed source files into runnable test files, using frontend validation rules, backend zod schemas and sampled DB rows as inputs.
---

# Generate native tests

Deterministic generator. It never executes or trusts model-written code.

## Pipeline
1. `bot/transformer.ts` projects each file into steps (declare, call, await, branch, loop, try, return, throw).
2. `bot/inputs.ts` builds input values from, in order: sampled DB rows (read-only, skipped without `DATABASE_URL`), frontend examples and validation rules, backend zod schemas, then plain samples. Scenario conditions are solved into concrete values.
3. `bot/tagger.ts` maps each step to a Jest matcher and mock, using the scraped Jest docs in `bot/data/jest-docs.json`.
4. `bot/testBuilder.ts` renders `<name>.gen.jest.ts` next to each source file: one test per code path, `jest.spyOn` / `jest.mocked` for external calls, snapshots for values that depend on intermediate state.

## Run
`npm run tests:gen -- <files...> [--runner jest|vitest] [--no-db] [--force] [--stdout]`

## Notes
- Sampled DB rows are written into the tests. Use `--no-db` or leave `DATABASE_URL` unset to avoid that.
- Anything the solver cannot decide is left as a `// TODO` comment, which the `propose-edge-cases` skill can fill.
