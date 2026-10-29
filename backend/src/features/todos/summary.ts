import type { Todo } from './types.js';

export interface TodoSummary {
  total: number;
  completed: number;
  overdue: number;
}

// `today` is a YYYY-MM-DD string so the result does not depend on the clock
export function summarizeTodos(todos: Todo[], today: string): TodoSummary {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error('today must be YYYY-MM-DD');
  }
  const completed = todos.filter((todo) => todo.completed).length;
  const overdue = todos.filter(
    (todo) => !todo.completed && todo.due_date !== null && todo.due_date < today,
  ).length;
  return { total: todos.length, completed, overdue };
}
