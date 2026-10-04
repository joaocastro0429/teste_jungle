import { createServer } from 'node:http';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Queues } from './queues';
import { registry } from './telemetry';
export function workerHealth(orm: MikroORM, queues: Queues) {
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/metrics') {
        response.setHeader('Content-Type', registry.contentType);
        response.end(await registry.metrics());
        return;
      }
      if (request.url === '/health/ready')
        await Promise.all([orm.em.fork().execute('SELECT 1'), queues.ready()]);
      else if (request.url !== '/health/live') {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
    } catch {
      response.statusCode = 503;
      response.end(JSON.stringify({ status: 'not_ready' }));
    }
  });
  server.listen(Number(process.env.WORKER_HEALTH_PORT ?? 3001), '0.0.0.0');
  return server;
}
