import { fromModel } from './mappers.js';
import type { Database, TodoStore, TodoCreate, TodoUpdate, Todo } from './types.js';

export class TodoRepository implements TodoStore {
  constructor(private readonly database: Pick<Database, 'todo'>) {}

  async list(): Promise<Todo[]> {
    const rows = await this.database.todo.findMany({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
    return rows.map(fromModel);
  }

  async get(id: number): Promise<Todo | null> {
    const record = await this.database.todo.findUnique({ where: { id } });
    return record ? fromModel(record) : null;
  }

  async create(payload: TodoCreate): Promise<Todo> {
    const now = new Date();
    const record = await this.database.todo.create({
      data: {
        ...payload,
        due_date: payload.due_date ? new Date(`${payload.due_date}T00:00:00.000Z`) : null,
        created_at: now,
        updated_at: now,
      },
    });
    return fromModel(record);
  }

  async update(id: number, payload: TodoUpdate): Promise<Todo | null> {
    const allowed = ['title', 'description', 'priority', 'due_date', 'completed'];
    const entries = Object.entries(payload);
    if (!entries.length || entries.some(([key]) => !allowed.includes(key))) {
      throw new Error('Invalid update fields.');
    }
    const rows = await this.database.todo.updateManyAndReturn({
      where: { id },
      data: {
        ...payload,
        due_date: payload.due_date ? new Date(`${payload.due_date}T00:00:00.000Z`) : payload.due_date,
        updated_at: new Date(),
      },
    });
    return rows.length ? fromModel(rows[0]) : null;
  }

  async delete(id: number): Promise<boolean> {
    const { count } = await this.database.todo.deleteMany({ where: { id } });
    return count > 0;
  }
}
