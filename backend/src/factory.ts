import express, { type ErrorRequestHandler } from 'express';
import type { Database } from './features/todos/types.js';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'node:fs';
import { createHealthRouter } from './api/health.js';
import { createTodosRouter } from './features/todos/router.js';
import { TodoRepository } from './features/todos/repository.js';

export function createApp(database: Database) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/api', createHealthRouter(database));
  app.use('/api/todos', createTodosRouter(new TodoRepository(database)));
  const specification = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  app.get('/openapi.json', (req, res) => res.json(specification));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(specification));
  app.use((req, res) => res.status(404).json({ detail: 'Not Found' }));
  const handleError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) return next(error);
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed') return res.status(422).json({ detail: 'Invalid JSON.' });
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') return res.status(413).json({ detail: 'Request body too large.' });
    console.error(error);
    res.status(500).json({ detail: 'Internal Server Error' });
  };
  app.use(handleError);
  return app;
}
