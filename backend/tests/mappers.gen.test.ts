import { describe, test, expect, vi, afterEach } from 'vitest';
import { fromModel } from '../src/features/todos/mappers.js';
import { todoSchema } from '../src/features/todos/validators.js';


// Generated from the code, frontend rules and sampled DB rows - review before committing. Jest APIs used:
//   test(name, fn, timeout) - https://jestjs.io/docs/api#testname-fn-timeout
//   describe(name, fn) - https://jestjs.io/docs/api#describename-fn
//   vi.mock(moduleName, factory, options) - https://jestjs.io/docs/jest-object#jestmockmodulename-factory-options
//   .toHaveBeenCalledWith(arg1, arg2, ...) - https://jestjs.io/docs/expect#tohavebeencalledwitharg1-arg2-
//   .toEqual(value) - https://jestjs.io/docs/expect#toequalvalue
//   expect(value) - https://jestjs.io/docs/expect#expectvalue
//   .toMatchSnapshot(propertyMatchers?, hint?) - https://jestjs.io/docs/expect#tomatchsnapshotpropertymatchers-hint

describe("fromModel", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  test("returns", () => {
    const record = {
      id: 7,
      created_at: new Date("2026-10-01T12:00:00.000Z"),
      updated_at: new Date("2026-10-01T12:00:00.000Z"),
    } as Parameters<typeof fromModel>[0];
    (vi.spyOn(todoSchema, 'parse' as never) as any).mockReturnValue(undefined as never); // TODO: stub result

    const result = fromModel(record);
    expect(result).toMatchSnapshot(); // characterises: todoSchema.parse({ id: record.id, title: record.title, description: record.descr
    expect(todoSchema.parse).toHaveBeenCalled(); // TODO: args depend on intermediate values: ({ id: record.id, title: record.title, description: record.description, priority: record.priority, due_date: record.due_date?.toISOString().slice(0, 10) ?? null, completed: record.completed, created_at: record.created_at.toISOString(), updated_at: record.updated_at.toISOString(), })
  });
});
