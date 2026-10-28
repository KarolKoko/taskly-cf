import type { TodoRecord, Todo } from '../src/features/todos/types.js';

export const record: TodoRecord = {
  id: 1, title: 'Plan the sprint', description: 'Details', priority: 'high',
  due_date: new Date('2026-10-15T00:00:00.000Z'), completed: false,
  created_at: new Date('2026-10-01T12:00:00Z'), updated_at: new Date('2026-10-01T12:00:00Z'),
};
export const todo: Todo = { ...record, priority: 'high', due_date: '2026-10-15', created_at: record.created_at.toISOString(), updated_at: record.updated_at.toISOString() };
