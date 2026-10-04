import { connectDatabase } from './infrastructure/database';
import { Queues } from './infrastructure/queues';
import { WageringService } from './application/wagering';
import { createApi } from './http/api';
import { log } from './infrastructure/telemetry';
const orm = await connectDatabase(),
  queues = new Queues();
try {
  await queues.initialize();
} catch (error) {
  await orm.close();
  queues.close();
  throw error;
}
const app = await createApi(new WageringService(orm), queues);
await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
log('api_started', { port: Number(process.env.PORT ?? 3000) });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await orm.close();
  queues.close();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
