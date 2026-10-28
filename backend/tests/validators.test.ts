import { describe, it, expect } from 'vitest';
import { createSchema, updateSchema, idSchema, todoSchema } from '../src/features/todos/validators.ts';
import { todo } from './fixture.ts';

describe('todo validation', () => {
  it('trims text and supplies create defaults', () => {
    expect(createSchema.parse({ title: '  Task  ' })).toEqual({
      title: 'Task', description: '', priority: 'medium', due_date: null, completed: false,
    });
  });
  it('accepts every input field and boundary lengths', () => {
    const input = { title: 'x'.repeat(120), description: 'x'.repeat(2000), priority: 'low', due_date: '2024-02-29', completed: true };
    expect(createSchema.parse(input)).toEqual(input);
    expect(updateSchema.parse({ description: '  Details  ', title: '  Task  ', priority: 'high', completed: false, due_date: null }))
      .toEqual({ description: 'Details', title: 'Task', priority: 'high', completed: false, due_date: null });
    expect(updateSchema.parse({ due_date: '2026-10-15' })).toEqual({ due_date: '2026-10-15' });
  });
  it.each([
    {}, { title: '' }, { title: '  ' }, { title: 'x'.repeat(121) },
    { title: 'Task', description: 'x'.repeat(2001) }, { title: 'Task', priority: 'urgent' },
    { title: 'Task', due_date: '2026-02-30' }, { title: 'Task', due_date: '2025-02-29' },
    { title: 'Task', due_date: '2026-10-15T12:00:00Z' }, { title: 'Task', completed: 'true' },
    { title: 'Task', completed: 1 }, { title: 'Task', id: 1 }, { title: null },
  ])('rejects invalid create input: %j', (input) => expect(createSchema.safeParse(input).success).toBe(false));
  it('rejects empty patches', () => {
    expect(() => updateSchema.parse({})).toThrow('Provide at least one field');
  });
  it.each(['title', 'description', 'priority', 'completed'])('rejects null %s in patches', (field) => {
    expect(updateSchema.safeParse({ [field]: null }).success).toBe(false);
  });
  it('forbids extra patch fields', () => expect(updateSchema.safeParse({ id: 1 }).success).toBe(false));
  it.each(['0', '-1', '1.5', 'abc', '9007199254740992'])('rejects invalid id %s', (id) => {
    expect(idSchema.safeParse(id).success).toBe(false);
  });
  it('parses positive ids and validates the response schema', () => {
    expect(idSchema.parse('12')).toBe(12);
    expect(todoSchema.parse(todo)).toEqual(todo);
    expect(todoSchema.safeParse({ ...todo, created_at: 'yesterday' }).success).toBe(false);
  });
});
