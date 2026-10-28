import { it, expect } from 'vitest';
import { fromModel } from '../src/features/todos/mappers.ts';
import { record, todo } from './fixture.ts';

it.each([false, true])('maps records to JSON without mutation (completed: %s)', (completed) => {
  const input = { ...record, completed };
  const before = structuredClone(input);
  expect(fromModel(input)).toEqual({ ...todo, completed });
  expect(input).toEqual(before);
});
it('preserves an absent due date', () => {
  expect(fromModel({ ...record, due_date: null }).due_date).toBeNull();
});
it('rejects invalid stored data', () => {
  expect(() => fromModel({ ...record, title: '' })).toThrow();
});
