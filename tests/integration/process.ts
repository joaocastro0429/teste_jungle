import { connectDatabase } from '../../src/infrastructure/database';
import { WageringService } from '../../src/application/wagering';
import { Queues } from '../../src/infrastructure/queues';
import { Workers } from '../../src/infrastructure/workers';
const orm = await connectDatabase(),
  service = new WageringService(orm);
try {
  const mode = process.argv[2];
  if (mode === 'submit') {
    const input = JSON.parse(process.env.TEST_INPUT!);
    await Promise.all(
      Array.from({ length: 17 }, () =>
        service.submit(input, process.env.TEST_KEY!, { correlationId: 'multi-process' }),
      ),
    );
  } else {
    const queues = new Queues();
    await queues.initialize();
    try {
      const workers = new Workers(service, queues, orm);
      if (mode === 'consume') await workers.consumeOnce();
      if (mode === 'publish') await workers.publishOnce();
    } finally {
      queues.close();
    }
  }
} finally {
  await orm.close();
}
