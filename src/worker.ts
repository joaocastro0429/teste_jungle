import { connectDatabase } from './infrastructure/database';
import { Queues } from './infrastructure/queues';
import { WageringService } from './application/wagering';
import { Workers } from './infrastructure/workers';
import { workerHealth } from './infrastructure/worker-health';
import { log } from './infrastructure/telemetry';
const orm = await connectDatabase(),
  queues = new Queues();
await queues.initialize();
const workers = new Workers(new WageringService(orm), queues, orm);
const health = workerHealth(orm, queues);
workers.start();
log('workers_started', { pid: process.pid });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve, reject) =>
    health.close((error) => (error ? reject(error) : resolve())),
  );
  await workers.stop();
  await orm.close();
  queues.close();
  log('workers_stopped');
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
