import { todoSchema } from './validators.js';
import type { TodoRecord, Todo } from './types.js';

export function fromModel(record: TodoRecord): Todo {
  return todoSchema.parse({
    id: record.id,
    title: record.title,
    description: record.description,
    priority: record.priority,
    due_date: record.due_date?.toISOString().slice(0, 10) ?? null,
    completed: record.completed,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
  });
}
