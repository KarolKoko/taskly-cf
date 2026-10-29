import { describe, test, expect, vi, afterEach } from 'vitest';
import { summarizeTodos } from '../src/features/todos/summary.js';


// Generated from the code, frontend rules and sampled DB rows - review before committing. Jest APIs used:
//   test(name, fn, timeout) - https://jestjs.io/docs/api#testname-fn-timeout
//   describe(name, fn) - https://jestjs.io/docs/api#describename-fn
//   vi.mock(moduleName, factory, options) - https://jestjs.io/docs/jest-object#jestmockmodulename-factory-options
//   .toHaveBeenCalledWith(arg1, arg2, ...) - https://jestjs.io/docs/expect#tohavebeencalledwitharg1-arg2-
//   test.each(table)(name, fn, timeout) - https://jestjs.io/docs/api#testeachtablename-fn-timeout
//   .toThrow(error?) - https://jestjs.io/docs/expect#tothrowerror
//   .toEqual(value) - https://jestjs.io/docs/expect#toequalvalue
//   expect(value) - https://jestjs.io/docs/expect#expectvalue
//   .toMatchSnapshot(propertyMatchers?, hint?) - https://jestjs.io/docs/expect#tomatchsnapshotpropertymatchers-hint

describe("summarizeTodos", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  test("throws when !/^\\d{4}-\\d{2}-\\d{2}$/.test(today)", () => {
    const todos = [{
      id: 7,
      created_at: "2026-10-01T12:00:00Z",
      updated_at: "2026-10-01T12:00:00Z",
    }] as Parameters<typeof summarizeTodos>[0];
    const today = "Sample today";

    expect(() => summarizeTodos(todos, today)).toThrow('today must be YYYY-MM-DD');
  });

  test("returns when !(!/^\\d{4}-\\d{2}-\\d{2}$/.test(today))", () => {
    const todos = [{
      id: 7,
      created_at: "2026-10-01T12:00:00Z",
      updated_at: "2026-10-01T12:00:00Z",
    }] as Parameters<typeof summarizeTodos>[0];
    const today = "2026-01-15";

    const result = summarizeTodos(todos, today);
    expect(result).toMatchSnapshot(); // characterises: { total: todos.length, completed: todos.filter(<fn>).length, overdue: todos.filt
  });
});
