import type { MikroORM } from '@mikro-orm/postgresql';
import { DomainError, NotFoundError } from '../domain/errors';
import { OutboxMessage } from '../domain/events';
import { object, text } from '../application/contracts';
import { WageringService } from '../application/wagering';
import { errorCode, log, metrics } from './telemetry';
import {
  Queues,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from './queues';
export class Workers {
  private stopping = false;
  private jobs: Promise<void>[] = [];
  constructor(
    readonly service: WageringService,
    readonly queues: Queues,
    readonly orm: MikroORM,
  ) {}
  start() {
    this.jobs = [
      this.loop('consumer', () => this.consumeOnce()),
      this.loop('outbox', () => this.publishOnce()),
      this.loop('reference', async () => {
        await this.service.retryReferences();
      }),
    ];
  }
  async stop() {
    this.stopping = true;
    await Promise.all(this.jobs);
  }
  private async loop(name: string, work: () => Promise<unknown>) {
    while (!this.stopping) {
      try {
        await work();
      } catch (error) {
        log('worker_error', { worker: name, code: errorCode(error) });
      }
      if (!this.stopping) await Bun.sleep(250);
    }
  }
  async publishOnce(): Promise<boolean> {
    const result = await this.orm.em.fork().transactional(async (em) => {
      const rows = await em.execute<
        {
          id: string;
          payload: Record<string, unknown>;
          aggregate_id: string;
          attempts: number;
          next_attempt_at: Date;
          published_at: Date | null;
        }[]
      >(
        'SELECT * FROM outbox WHERE published_at IS NULL AND next_attempt_at<=now() ORDER BY occurred_at,id LIMIT 1 FOR UPDATE SKIP LOCKED',
      );
      if (!rows.length) return false;
      const row = rows[0]!,
        message = OutboxMessage.rehydrate({
          id: row.id,
          payload: row.payload,
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at,
          publishedAt: row.published_at ?? undefined,
        });
      try {
        await this.queues.client.send(
          new SendMessageCommand({
            QueueUrl: this.queues.events,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: row.aggregate_id,
            MessageDeduplicationId: row.id,
          }),
        );
        if (process.env.NODE_ENV === 'test' && process.env.TEST_CRASH_AFTER_PUBLISH === '1')
          process.kill(process.pid, 'SIGKILL');
        message.markPublished(new Date());
        await em.execute('UPDATE outbox SET published_at=? WHERE id=?', [
          message.publishedAt,
          row.id,
        ]);
      } catch (error) {
        message.scheduleRetry(new Date());
        metrics.retries.inc({ worker: 'outbox' });
        await em.execute('UPDATE outbox SET attempts=?,next_attempt_at=? WHERE id=?', [
          message.attempts,
          message.nextAttemptAt,
          row.id,
        ]);
        log('outbox_retry', {
          eventId: row.id,
          walletId: row.aggregate_id,
          code: errorCode(error),
        });
      }
      return true;
    });
    const lag = (
      await this.orm.em
        .fork()
        .execute<{ seconds: string }[]>(
          `SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(occurred_at)),0)::text AS seconds FROM outbox WHERE published_at IS NULL`,
        )
    )[0]!;
    metrics.lag.set(Math.max(0, Number(lag.seconds)));
    return result;
  }
  async consumeOnce(): Promise<boolean> {
    const received = await this.queues.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queues.input,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        VisibilityTimeout: 30,
      }),
    );
    const message = received.Messages?.[0];
    if (!message) return false;
    const receipt = message.ReceiptHandle!,
      count = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    if (this.stopping) {
      await this.queues.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queues.input,
          ReceiptHandle: receipt,
          VisibilityTimeout: 0,
        }),
      );
      return false;
    }
    // A long DB/transport delay must not allow an in-flight receipt to expire during graceful shutdown.
    const heartbeat = setInterval(() => {
      void this.queues.client
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queues.input,
            ReceiptHandle: receipt,
            VisibilityTimeout: 30,
          }),
        )
        .catch(() => {});
    }, 10000);
    let messageId: string | undefined;
    try {
      let envelope: Record<string, unknown>;
      try {
        envelope = object(JSON.parse(message.Body ?? ''));
      } catch {
        throw new DomainError('INVALID_ENVELOPE');
      }
      messageId = text(envelope.messageId, 'messageId');
      if (
        envelope.type !== 'WagerTransactionRequested' ||
        typeof envelope.occurredAt !== 'string' ||
        !Number.isFinite(Date.parse(envelope.occurredAt))
      )
        throw new DomainError('INVALID_ENVELOPE');
      const data = object(envelope.data);
      await this.service.submit(data, data.idempotencyKey, {
        messageId,
        consumerName: 'wager-consumer',
        correlationId: messageId,
        causationId: messageId,
      });
      if (process.env.NODE_ENV === 'test' && process.env.TEST_CRASH_AFTER_COMMIT === '1')
        process.kill(process.pid, 'SIGKILL');
      await this.queues.client.send(
        new DeleteMessageCommand({ QueueUrl: this.queues.input, ReceiptHandle: receipt }),
      );
    } catch (error) {
      const permanent = error instanceof DomainError && !(error instanceof NotFoundError);
      // Invalid transport payloads and conflicting identities cannot be corrected by retrying.
      // Business rejections are returned by submit and acknowledged in the success branch.
      if (permanent || count >= 5) {
        await this.queues.client.send(
          new SendMessageCommand({
            QueueUrl: this.queues.dlq,
            MessageBody: message.Body ?? '{}',
            MessageGroupId: 'invalid',
            MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
            MessageAttributes: {
              failureCode: { DataType: 'String', StringValue: errorCode(error) },
            },
          }),
        );
        await this.queues.client.send(
          new DeleteMessageCommand({ QueueUrl: this.queues.input, ReceiptHandle: receipt }),
        );
        metrics.dlq.inc();
        log('message_dlq', { messageId, code: errorCode(error) });
      } else {
        await this.queues.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queues.input,
            ReceiptHandle: receipt,
            VisibilityTimeout: Math.min(60, 2 ** count),
          }),
        );
        metrics.retries.inc({ worker: 'consumer' });
        log('message_retry', { messageId, code: errorCode(error), attempt: count });
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}
