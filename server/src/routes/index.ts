import type { Express } from 'express';
import { connectionsRouter } from './connections.js';
import { dataRouter } from './data.js';

export function registerRoutes(app: Express): void {
  app.use('/api/connections', connectionsRouter);
  app.use('/api/connections', dataRouter);
}
