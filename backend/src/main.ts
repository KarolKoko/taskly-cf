import { start } from './core/lifespan.js';

start().catch((error) => {
  console.error('Cannot start Taskly App Node API:', error);
  process.exitCode = 1;
});
