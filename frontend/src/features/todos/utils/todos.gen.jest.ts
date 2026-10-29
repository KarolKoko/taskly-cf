import { describe, test, expect, jest, afterEach } from '@jest/globals';
import { validateTodo, selectTodos, isOverdue, formatDate } from './todos';


// Generated from the code, frontend rules and sampled DB rows - review before committing. Jest APIs used:
//   test(name, fn, timeout) - https://jestjs.io/docs/api#testname-fn-timeout
//   describe(name, fn) - https://jestjs.io/docs/api#describename-fn
//   jest.mock(moduleName, factory, options) - https://jestjs.io/docs/jest-object#jestmockmodulename-factory-options
//   .toHaveBeenCalledWith(arg1, arg2, ...) - https://jestjs.io/docs/expect#tohavebeencalledwitharg1-arg2-
//   test.each(table)(name, fn, timeout) - https://jestjs.io/docs/api#testeachtablename-fn-timeout
//   .toEqual(value) - https://jestjs.io/docs/expect#toequalvalue
//   expect(value) - https://jestjs.io/docs/expect#expectvalue
//   .toMatchSnapshot(propertyMatchers?, hint?) - https://jestjs.io/docs/expect#tomatchsnapshotpropertymatchers-hint

describe("validateTodo", () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test("returns when !input.title.trim() and input.description.trim().length > 2000 and input.due_date and !/^\\d{4}...", () => {
    const input = {
      title: "",
      description: "a".repeat(2001),
      priority: "medium",
      due_date: "!",
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !input.title.trim() and input.description.trim().length > 2000 and input.due_date and !(!/^\\d{...", () => {
    const input = {
      title: "",
      description: "a".repeat(2001),
      priority: "medium",
      due_date: "2026-01-15",
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !input.title.trim() and input.description.trim().length > 2000 and !(input.due_date)", () => {
    const input = {
      title: "",
      description: "a".repeat(2001),
      priority: "medium",
      due_date: null,
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !input.title.trim() and !(input.description.trim().length > 2000) and input.due_date and !/^\\d...", () => {
    const input = {
      title: "",
      description: "a".repeat(2000),
      priority: "medium",
      due_date: "!",
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !input.title.trim() and !(input.description.trim().length > 2000) and input.due_date and !(!/^...", () => {
    const input = {
      title: "",
      description: "a".repeat(2000),
      priority: "medium",
      due_date: "2026-01-15",
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !input.title.trim() and !(input.description.trim().length > 2000) and !(input.due_date)", () => {
    const input = {
      title: "",
      description: "a".repeat(2000),
      priority: "medium",
      due_date: null,
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !(!input.title.trim()) and input.title.trim().length > 120 and input.description.trim().length...", () => {
    const input = {
      title: "a".repeat(121),
      description: "a".repeat(2001),
      priority: "medium",
      due_date: "!",
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !(!input.title.trim()) and input.title.trim().length > 120 and input.description.trim().length...", () => {
    const input = {
      title: "a".repeat(121),
      description: "a".repeat(2001),
      priority: "medium",
      due_date: "2026-01-15",
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !(!input.title.trim()) and input.title.trim().length > 120 and input.description.trim().length...", () => {
    const input = {
      title: "a".repeat(121),
      description: "a".repeat(2001),
      priority: "medium",
      due_date: null,
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !(!input.title.trim()) and input.title.trim().length > 120 and !(input.description.trim().leng...", () => {
    const input = {
      title: "a".repeat(121),
      description: "a".repeat(2000),
      priority: "medium",
      due_date: "!",
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !(!input.title.trim()) and input.title.trim().length > 120 and !(input.description.trim().leng...", () => {
    const input = {
      title: "a".repeat(121),
      description: "a".repeat(2000),
      priority: "medium",
      due_date: "2026-01-15",
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });

  test("returns when !(!input.title.trim()) and input.title.trim().length > 120 and !(input.description.trim().leng...", () => {
    const input = {
      title: "a".repeat(121),
      description: "a".repeat(2000),
      priority: "medium",
      due_date: null,
      completed: false,
    } as Parameters<typeof validateTodo>[0];

    const result = validateTodo(input);
    expect(result).toMatchSnapshot(); // characterises: errors
  });
});

describe("selectTodos", () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test("returns", () => {
    const todos = [{
      id: 7,
      created_at: "2026-10-01T12:00:00Z",
      updated_at: "2026-10-01T12:00:00Z",
    }] as Parameters<typeof selectTodos>[0];
    const filter = "all";
    const query = "Sample query";
    const sort = "newest";

    const result = selectTodos(todos, filter, query, sort);
    expect(result).toMatchSnapshot(); // characterises: todos .filter(<fn>) .sort(<fn>)
  });
});

describe("isOverdue", () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test("returns", () => {
    const todo = {
      id: 7,
      created_at: "2026-10-01T12:00:00Z",
      updated_at: "2026-10-01T12:00:00Z",
    } as Parameters<typeof isOverdue>[0];

    const result = isOverdue(todo);
    expect(result).toEqual(!todo.completed && !!todo.due_date && todo.due_date < `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
  });
});

describe("formatDate", () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test("returns", () => {
    const date = "2026-01-15";

    const result = formatDate(date);
    expect(result).toMatchSnapshot(); // characterises: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeri
  });
});
