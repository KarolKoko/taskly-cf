import { z } from 'zod';

const fields = {
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  priority: z.enum(['low', 'medium', 'high']),
  due_date: z.iso.date().nullable(),
  completed: z.boolean(),
};

export const createSchema = z.strictObject({
  ...fields,
  description: fields.description.default(''),
  priority: fields.priority.default('medium'),
  due_date: fields.due_date.default(null),
  completed: fields.completed.default(false),
});
export const updateSchema = z.strictObject(fields).partial().refine(
  (value) => Object.keys(value).length > 0,
  'Provide at least one field to update.',
);
export const idSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const todoSchema = createSchema.extend({
  id: z.number().int().positive(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
