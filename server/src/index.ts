import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { authToken, host, preferredPort, version, webDistDir } from './config.js';
import { disposeAll } from './db/manager.js';
import { registerRoutes } from './routes/index.js';
import { HttpError, describeError } from './routes/helpers.js';
import { jsonReplacer } from './util/csv.js';

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', jsonReplacer);
  app.use(cors());
  app.use(express.json({ limit: '16mb' }));

  if (authToken) {
    app.use('/api', (req, res, next) => {
      if (req.get('x-db-tool-token') !== authToken) {
        res.status(401).json({ error: '未授权的请求' });
        return;
      }
      next();
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version });
  });

  registerRoutes(app);

  if (existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(join(webDistDir, 'index.html'));
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : 400;
    res.status(status).json(describeError(error));
  };
  app.use(errorHandler);

  return app;
}

export async function startServer(): Promise<RunningServer> {
  const app = createApp();
  let port = preferredPort;
  /** With an OS-assigned port there is nothing to walk forward from. */
  const canIncrement = preferredPort !== 0;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 25; attempt++) {
    const server = await new Promise<import('node:http').Server | null>((resolve) => {
      const candidate = app.listen(port, host);
      candidate.once('listening', () => resolve(candidate));
      candidate.once('error', (error) => {
        lastError = error;
        candidate.close();
        resolve(null);
      });
    });
    if (server) {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      return {
        port: actualPort,
        url,
        close: async () => {
          await disposeAll();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    }
    if (canIncrement) port += 1;
  }

  throw lastError instanceof Error ? lastError : new Error('无法启动本地服务');
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  startServer()
    .then((server) => {
      process.stdout.write(`__DB_TOOL_READY__${JSON.stringify({ port: server.port, url: server.url })}\n`);
      console.log(`DB Tool is running at ${server.url}`);
    })
    .catch((error) => {
      console.error('server failed to start:', error);
      process.exit(1);
    });
}
