import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { connectDatabase } from '../../src/infrastructure/database';
import { WageringService } from '../../src/application/wagering';
import {
  Queues,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
} from '../../src/infrastructure/queues';
import { Workers } from '../../src/infrastructure/workers';
import type { WagerInput } from '../../src/domain/transaction';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { createApi } from '../../src/http/api';
import type { INestApplication } from '@nestjs/common';
let adminOrm: MikroORM;
let testDatabase: string;
const originalUrl = process.env.DATABASE_URL,
  originalPrefix = process.env.QUEUE_PREFIX;
let orm: MikroORM,
  service: WageringService,
  queues: Queues,
  workers: Workers,
  app: INestApplication,
  base: string;
const context = { correlationId: 'integration' };
async function waitFor(check: () => Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error('Timed out waiting for observed state');
}
async function wallet(amount = '100.00') {
  return service.createWallet(
    { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } },
    context,
  );
}
function input(
  w: Awaited<ReturnType<typeof wallet>>,
  kind: WagerInput['kind'] = 'BET',
  amount = '10.00',
  ref?: string,
): WagerInput {
  return {
    providerId: 'test-provider',
    externalTransactionId: crypto.randomUUID(),
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: { amount, currency: 'BRL' },
    ...(ref ? { referenceExternalTransactionId: ref } : {}),
  };
}
async function submit(p: WagerInput, key = p.externalTransactionId) {
  return service.submit(p, key, context);
}
async function consistent(id: string) {
  const r = await service.reconcile(id, context);
  expect(r.consistent).toBe(true);
  return r;
}
async function child(mode: string, env: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, 'tests/integration/process.ts', mode], {
    env: { ...process.env, NODE_ENV: 'test', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await p.exited;
  if (code && !env.TEST_CRASH_AFTER_COMMIT && !env.TEST_CRASH_AFTER_PUBLISH)
    throw new Error(await new Response(p.stderr).text());
  return code;
}
async function receive(url: string) {
  for (let i = 0; i < 10; i++) {
    const r = await queues.client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 1,
      }),
    );
    if (r.Messages?.length) return r.Messages;
  }
  return [];
}
beforeAll(async () => {
  adminOrm = await connectDatabase();
  testDatabase = 'jungle_test_' + crypto.randomUUID().replaceAll('-', '');
  await adminOrm.em.fork().execute(`CREATE DATABASE ${testDatabase}`);
  const url = new URL(originalUrl ?? 'postgresql://jungle:jungle@localhost:55432/jungle');
  url.pathname = '/' + testDatabase;
  process.env.DATABASE_URL = url.toString();
  process.env.QUEUE_PREFIX = 'test-' + crypto.randomUUID().slice(0, 8) + '-';
  const migration = Bun.spawn([process.execPath, 'scripts/migrate.ts', 'up'], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await migration.exited) !== 0) throw new Error(await new Response(migration.stderr).text());
  orm = await connectDatabase();
  service = new WageringService(orm);
  queues = new Queues();
  await queues.initialize();
  workers = new Workers(service, queues, orm);
  app = await createApi(service, queues);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await orm?.close();
  if (queues) {
    await Promise.all(
      [queues.input, queues.events, queues.dlq]
        .filter(Boolean)
        .map((QueueUrl) => queues.client.send(new DeleteQueueCommand({ QueueUrl }))),
    );
    queues.close();
  }
  if (adminOrm) {
    if (testDatabase) await adminOrm.em.fork().execute(`DROP DATABASE ${testDatabase}`);
    await adminOrm.close();
  }
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
  if (originalPrefix === undefined) delete process.env.QUEUE_PREFIX;
  else process.env.QUEUE_PREFIX = originalPrefix;
});
describe('PostgreSQL guarantees and HTTP', () => {
  test('opening ledger, duplicate wallet, zero opening, stable cursor', async () => {
    const w = await wallet();
    const r = await consistent(w.id);
    expect(r.checkedEntries).toBe(1);
    expect(w.version).toBe(1);
    await expect(
      service.createWallet(
        { playerId: w.playerId, initialBalance: { amount: '0.00', currency: 'BRL' } },
        context,
      ),
    ).rejects.toThrow('WALLET_ALREADY_EXISTS');
    const empty = await wallet('0.00');
    expect((await consistent(empty.id)).checkedEntries).toBe(0);
    await submit(input(w));
    await submit(input(w));
    const first = await service.ledger(w.id, undefined, '1');
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const next = await service.ledger(w.id, first.nextCursor!, '100');
    expect(next.items).toHaveLength(2);
    await expect(service.ledger(empty.id, first.nextCursor!)).rejects.toThrow('INVALID_CURSOR');
  });
  test('database rejects negative balance, ledger mutation and missing financial ledger', async () => {
    const w = await wallet();
    await expect(
      orm.em.fork().execute('UPDATE wallets SET balance=-1 WHERE id=?', [w.id]),
    ).rejects.toThrow();
    await expect(
      orm.em
        .fork()
        .execute("UPDATE wallets SET balance='NaN',version=version+1 WHERE id=?", [w.id]),
    ).rejects.toThrow('finite_balance');
    await expect(
      orm.em.fork().execute('UPDATE wallets SET balance=90,version=version+1 WHERE id=?', [w.id]),
    ).rejects.toThrow('wallet/ledger mismatch');
    await expect(
      orm.em.fork().execute('UPDATE wallets SET version=version+1 WHERE id=?', [w.id]),
    ).rejects.toThrow('version');
    await expect(
      orm.em.fork().execute('UPDATE wallet_ledger SET amount=amount WHERE wallet_id=?', [w.id]),
    ).rejects.toThrow('append-only');
    await expect(
      orm.em.fork().execute('DELETE FROM wallet_ledger WHERE wallet_id=?', [w.id]),
    ).rejects.toThrow('append-only');
    const opening = (
      await orm.em
        .fork()
        .execute<{ id: string }[]>('SELECT id FROM wager_transactions WHERE wallet_id=?', [w.id])
    )[0]!;
    await expect(
      orm.em
        .fork()
        .execute('UPDATE wager_transactions SET status=? WHERE id=?', ['PENDING', opening.id]),
    ).rejects.toThrow('immutable');
    await expect(
      orm.em.fork().execute('DELETE FROM wager_transactions WHERE id=?', [opening.id]),
    ).rejects.toThrow('audit records');
    await consistent(w.id);
  });
  test('atomic rollback includes inbox, outbox, wallet and ledger', async () => {
    const w = await wallet();
    const before = await orm.em
      .fork()
      .execute<{ count: string }[]>(
        'SELECT count(*)::text AS count FROM outbox WHERE aggregate_id=?',
        [w.id],
      );
    await expect(
      orm.em.fork().transactional(async (em) => {
        await em.execute(
          "INSERT INTO inbox(consumer_name,message_id,payload_hash) VALUES ('atomic-test',?,'hash')",
          [w.id],
        );
        await em.execute(
          "INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES (?,?,'test','{}')",
          [crypto.randomUUID(), w.id],
        );
        await em.execute('UPDATE wallets SET balance=99,version=version+1 WHERE id=?', [w.id]);
        throw new Error('injected rollback');
      }),
    ).rejects.toThrow('injected rollback');
    expect((await service.getWallet(w.id)).balance.amount).toBe('100.00');
    expect(
      await orm.em.fork().execute('SELECT * FROM inbox WHERE message_id=?', [w.id]),
    ).toHaveLength(0);
    expect(
      await orm.em
        .fork()
        .execute('SELECT count(*)::text AS count FROM outbox WHERE aggregate_id=?', [w.id]),
    ).toEqual(before);
    await consistent(w.id);
  });
  test('HTTP validation, idempotency conflict, rejection and readiness', async () => {
    const w = await wallet(),
      p = input(w, 'BET', '80.00');
    const request = (payload: unknown, key?: string) =>
      fetch(`${base}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
        body: JSON.stringify(payload),
      });
    expect((await request(p)).status).toBe(400);
    expect((await request(p, 'http-' + p.externalTransactionId)).status).toBe(200);
    const duplicate = await request(p, 'http-' + p.externalTransactionId);
    expect((await duplicate.json()).idempotentReplay).toBe(true);
    expect(
      (
        await request(
          { ...p, money: { amount: '70.00', currency: 'BRL' } },
          'http-' + p.externalTransactionId,
        )
      ).status,
    ).toBe(409);
    expect((await request(input(w, 'BET', '80.00'), crypto.randomUUID())).status).toBe(422);
    expect((await request({ ...input(w), kind: 'OPENING' }, crypto.randomUUID())).status).toBe(400);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
    await consistent(w.id);
  });
});
describe('Reversible migrations', () => {
  test('up, down, up on a separate disposable database', async () => {
    const name = 'jungle_migration_' + crypto.randomUUID().replaceAll('-', '');
    await orm.em.fork().execute(`CREATE DATABASE ${name}`);
    const url = new URL(
      process.env.DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:55432/jungle',
    );
    url.pathname = '/' + name;
    try {
      for (const direction of ['up', 'down', 'up']) {
        const migrationProcess = Bun.spawn([process.execPath, 'scripts/migrate.ts', direction], {
          env: { ...Bun.env, DATABASE_URL: url.toString() },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const code = await migrationProcess.exited;
        if (code !== 0) throw new Error(await new Response(migrationProcess.stderr).text());
      }
    } finally {
      await orm.em.fork().execute(`DROP DATABASE ${name}`);
    }
  });
});
describe('Real races and monetary business rules', () => {
  test('50 parallel copies cause one debit; historical replay balance', async () => {
    const w = await wallet(),
      p = input(w);
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(p)));
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect((await service.getWallet(w.id)).balance.amount).toBe('90.00');
    await submit(input(w));
    expect((await submit(p)).balance.amount).toBe('90.00');
    expect((await consistent(w.id)).checkedEntries).toBe(3);
  });
  test('two bets of 80 compete for 100', async () => {
    const w = await wallet(),
      a = input(w, 'BET', '80.00'),
      b = input(w, 'BET', '80.00');
    const r = await Promise.all([submit(a), submit(b)]);
    expect(r.map((x) => x.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect((await service.getWallet(w.id)).balance.amount).toBe('20.00');
    expect((await consistent(w.id)).checkedEntries).toBe(2);
  });
  test('distinct wallets and >=3 OS processes', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => wallet()));
    await Promise.all(wallets.map((w) => submit(input(w))));
    for (const w of wallets) await consistent(w.id);
    const w = await wallet(),
      p = input(w),
      env = { TEST_INPUT: JSON.stringify(p), TEST_KEY: p.externalTransactionId };
    await Promise.all([child('submit', env), child('submit', env), child('submit', env)]);
    expect((await service.getWallet(w.id)).balance.amount).toBe('90.00');
    expect((await consistent(w.id)).checkedEntries).toBe(2);
  });
  test('WIN LOSS REFUND ROLLBACK, duplicate reversal and currency mismatch', async () => {
    const w = await wallet(),
      bet = input(w);
    await submit(bet);
    const loss = input(w, 'LOSS', '0.00', bet.externalTransactionId);
    expect((await submit(loss)).status).toBe('PROCESSED');
    const refund = input(w, 'REFUND', '10.00', bet.externalTransactionId);
    expect((await submit(refund)).status).toBe('PROCESSED');
    expect((await submit(input(w, 'REFUND', '10.00', bet.externalTransactionId))).failureCode).toBe(
      'ALREADY_REVERSED',
    );
    expect((await submit(input(w, 'ROLLBACK', '10.00', refund.externalTransactionId))).status).toBe(
      'PROCESSED',
    );
    const win = input(w, 'WIN', '50.00', bet.externalTransactionId);
    await submit(win);
    await submit(input(w, 'BET', '140.00'));
    const reversal = await submit(input(w, 'ROLLBACK', '50.00', win.externalTransactionId));
    expect(reversal.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    const mismatch = input(w);
    mismatch.money.currency = 'USD';
    expect((await submit(mismatch)).failureCode).toBe('CURRENCY_MISMATCH');
    expect((await consistent(w.id)).checkedEntries).toBe(6);
  });
  test('reference context, amount and kind failures remain audit-only', async () => {
    const w = await wallet(),
      other = await wallet(),
      bet = input(w);
    await submit(bet);
    expect((await submit(input(w, 'REFUND', '9.00', bet.externalTransactionId))).failureCode).toBe(
      'REFERENCE_AMOUNT_MISMATCH',
    );
    expect(
      (await submit(input(other, 'REFUND', '10.00', bet.externalTransactionId))).failureCode,
    ).toBe('REFERENCE_CONTEXT_MISMATCH');
    const win = input(w, 'WIN', '5.00');
    await submit(win);
    expect((await submit(input(w, 'REFUND', '5.00', win.externalTransactionId))).failureCode).toBe(
      'INVALID_REFERENCE_KIND',
    );
    const wrongPlayer = { ...input(w), playerId: crypto.randomUUID() };
    expect((await submit(wrongPlayer)).failureCode).toBe('PLAYER_MISMATCH');
    const rejected = input(w, 'BET', '999.00');
    await submit(rejected);
    expect(
      (await submit(input(w, 'REFUND', '999.00', rejected.externalTransactionId))).failureCode,
    ).toBe('REFERENCE_NOT_PROCESSED');
    const original = input(w);
    await submit(original);
    await expect(submit({ ...original, walletId: crypto.randomUUID() })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    await expect(submit(original, crypto.randomUUID())).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await consistent(w.id);
    await consistent(other.id);
  });
  test('out of order REFUND and ROLLBACK and missing reference expiry', async () => {
    for (const kind of ['REFUND', 'ROLLBACK'] as const) {
      const w = await wallet(),
        bet = input(w),
        reverse = input(w, kind, '10.00', bet.externalTransactionId);
      const pending = await submit(reverse);
      expect(pending.status).toBe('PENDING_REFERENCE');
      await submit(bet);
      await orm.em
        .fork()
        .execute('UPDATE wager_transactions SET next_attempt_at=now() WHERE id=?', [
          pending.transactionId,
        ]);
      await Promise.all([service.retryReferences(), service.retryReferences()]);
      expect((await service.getTransaction(pending.transactionId)).status).toBe('PROCESSED');
      expect((await consistent(w.id)).storedBalance.amount).toBe('100.00');
    }
    const w = await wallet(),
      r = await submit(input(w, 'REFUND', '10.00', 'missing'));
    await orm.em
      .fork()
      .execute('UPDATE wager_transactions SET attempts=10,next_attempt_at=now() WHERE id=?', [
        r.transactionId,
      ]);
    await service.retryReferences();
    expect((await service.getTransaction(r.transactionId)).failureCode).toBe('REFERENCE_EXPIRED');
    await consistent(w.id);
  });
});
describe('Real SQS, inbox, outbox and crash recovery', () => {
  test('inbox duplicate and payload conflict', async () => {
    const w = await wallet(),
      p = input(w),
      ctx = { ...context, messageId: crypto.randomUUID() };
    const a = await service.submit(p, p.externalTransactionId, ctx),
      b = await service.submit(p, p.externalTransactionId, ctx);
    expect(a.idempotentReplay).toBe(false);
    expect(b.idempotentReplay).toBe(true);
    await expect(
      service.submit(
        { ...p, money: { amount: '11.00', currency: 'BRL' } },
        p.externalTransactionId,
        ctx,
      ),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const newInput = { ...p, externalTransactionId: crypto.randomUUID() };
    await expect(service.submit(newInput, newInput.externalTransactionId, ctx)).rejects.toThrow(
      'INBOX_PAYLOAD_CONFLICT',
    );
    await consistent(w.id);
  });
  test('worker killed after commit before ack, redelivery and restart', async () => {
    const w = await wallet(),
      p = input(w),
      messageId = crypto.randomUUID();
    await queues.client.send(
      new SendMessageCommand({
        QueueUrl: queues.input,
        MessageGroupId: w.id,
        MessageDeduplicationId: crypto.randomUUID(),
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...p, idempotencyKey: p.externalTransactionId },
        }),
      }),
    );
    expect(await child('consume', { TEST_CRASH_AFTER_COMMIT: '1' })).not.toBe(0);
    expect((await service.getWallet(w.id)).balance.amount).toBe('90.00');
    // Shorten visibility for deterministic recovery; use a new process to prove no memory state is required.
    await Bun.sleep(31000);
    expect(await child('consume')).toBe(0);
    expect((await consistent(w.id)).checkedEntries).toBe(2);
    const row = await orm.em.fork().execute('SELECT * FROM inbox WHERE message_id=?', [messageId]);
    expect(row).toHaveLength(1);
  });
  test('two concurrent publishers eventually drain pending events', async () => {
    const w = await wallet();
    await submit(input(w));
    for (let i = 0; i < 500; i++) {
      const results = await Promise.all([workers.publishOnce(), workers.publishOnce()]);
      if (results.every((r) => !r)) break;
    }
    expect(
      await orm.em
        .fork()
        .execute('SELECT id FROM outbox WHERE aggregate_id=? AND published_at IS NULL', [w.id]),
    ).toHaveLength(0);
    const published = await receive(queues.events);
    expect(published.length).toBeGreaterThan(0);
    for (const msg of published) {
      expect(JSON.parse(msg.Body!).eventId).toBeTruthy();
      await queues.client.send(
        new DeleteMessageCommand({ QueueUrl: queues.events, ReceiptHandle: msg.ReceiptHandle! }),
      );
    }
    await consistent(w.id);
  });
  test('outbox survives SQS outage and crash after publish before marker', async () => {
    const w = await wallet();
    const endpoint = process.env.SQS_ENDPOINT;
    process.env.SQS_ENDPOINT = 'http://127.0.0.1:1';
    const unavailable = new Queues();
    if (endpoint === undefined) delete process.env.SQS_ENDPOINT;
    else process.env.SQS_ENDPOINT = endpoint;
    unavailable.events = queues.events;
    try {
      await new Workers(service, unavailable, orm).publishOnce();
    } finally {
      unavailable.close();
    }
    const retry = await orm.em
      .fork()
      .execute<{ id: string; attempts: number }[]>(
        'SELECT id,attempts FROM outbox WHERE published_at IS NULL AND attempts>0',
      );
    expect(retry.length).toBeGreaterThan(0);
    await orm.em
      .fork()
      .execute('UPDATE outbox SET next_attempt_at=now() WHERE published_at IS NULL');
    expect(await child('publish', { TEST_CRASH_AFTER_PUBLISH: '1' })).not.toBe(0);
    expect(
      (await orm.em.fork().execute('SELECT id FROM outbox WHERE published_at IS NULL')).length,
    ).toBeGreaterThan(0);
    // The same eventId is retried. FIFO dedup is an optimization; downstream must persist eventId.
    for (let i = 0; i < 30; i++) if (!(await workers.publishOnce())) break;
    expect(
      await orm.em
        .fork()
        .execute('SELECT id FROM outbox WHERE aggregate_id=? AND published_at IS NULL', [w.id]),
    ).toHaveLength(0);
    await consistent(w.id);
  });
  test('invalid envelope to DLQ and transient missing wallet retry', async () => {
    const tag = crypto.randomUUID();
    await queues.client.send(
      new SendMessageCommand({
        QueueUrl: queues.input,
        MessageGroupId: tag,
        MessageDeduplicationId: tag,
        MessageBody: 'invalid-json',
      }),
    );
    await workers.consumeOnce();
    const invalid = await receive(queues.dlq);
    expect(invalid.some((m) => m.Body === 'invalid-json')).toBe(true);
    for (const m of invalid)
      await queues.client.send(
        new DeleteMessageCommand({ QueueUrl: queues.dlq, ReceiptHandle: m.ReceiptHandle! }),
      );
    const w = await wallet(),
      p = { ...input(w), walletId: crypto.randomUUID() },
      id = crypto.randomUUID();
    await queues.client.send(
      new SendMessageCommand({
        QueueUrl: queues.input,
        MessageGroupId: id,
        MessageDeduplicationId: id,
        MessageBody: JSON.stringify({
          messageId: id,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...p, idempotencyKey: id },
        }),
      }),
    );
    await workers.consumeOnce();
    await Bun.sleep(2100);
    const retry = await receive(queues.input);
    expect(retry.length).toBeGreaterThan(0);
    // Direct receives increment ApproximateReceiveCount as real redelivery does.
    for (const m of retry)
      await queues.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.input,
          ReceiptHandle: m.ReceiptHandle!,
          VisibilityTimeout: 0,
        }),
      );
    for (let i = 0; i < 6; i++) {
      const r = await queues.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.input,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 0,
        }),
      );
      if (!r.Messages?.length) break;
    }
    const dead = await receive(queues.dlq);
    expect(dead.some((m) => m.Body?.includes(id))).toBe(true);
    for (const m of dead)
      await queues.client.send(
        new DeleteMessageCommand({ QueueUrl: queues.dlq, ReceiptHandle: m.ReceiptHandle! }),
      );
    await consistent(w.id);
  });
});

describe('Additional failure and audit guarantees', () => {
  test('LOSS and rejection preserve version and emit no balance event', async () => {
    const w = await wallet();
    const loss = await submit(input(w, 'LOSS', '0.00'));
    const rejected = await submit(input(w, 'BET', '101.00'));
    expect(loss.status).toBe('PROCESSED');
    expect(rejected.status).toBe('REJECTED');
    expect((await service.getWallet(w.id)).version).toBe(1);
    expect((await consistent(w.id)).checkedEntries).toBe(1);
    const events = await orm.em.fork().execute<
      {
        event_type: string;
        payload: {
          eventId: string;
          aggregateId: string;
          version: number;
          correlationId: string;
          occurredAt: string;
        };
      }[]
    >('SELECT event_type,payload FROM outbox WHERE aggregate_id=?', [w.id]);
    expect(events.filter((e) => e.event_type === 'WalletBalanceChanged')).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'WagerTransactionProcessed')).toHaveLength(2);
    expect(events.filter((e) => e.event_type === 'WagerTransactionRejected')).toHaveLength(1);
    for (const event of events) {
      expect(event.payload.eventId).toBeTruthy();
      expect(event.payload.aggregateId).toBe(w.id);
      expect(event.payload.version).toBe(1);
      expect(event.payload.correlationId).toBe(context.correlationId);
      expect(Number.isFinite(Date.parse(event.payload.occurredAt))).toBe(true);
    }
  });
  test('rejected replay remains rejected after a later credit', async () => {
    const w = await wallet(),
      p = input(w, 'BET', '101.00');
    const original = await submit(p);
    await submit(input(w, 'WIN', '50.00'));
    expect(await submit(p)).toEqual({ ...original, idempotentReplay: true });
    expect((await service.getWallet(w.id)).balance.amount).toBe('150.00');
    expect((await consistent(w.id)).checkedEntries).toBe(2);
  });
  test('maximum balance overflow is an audited rejection with no partial credit', async () => {
    const w = await wallet('9999999999999999.99');
    const result = await submit(input(w, 'WIN', '0.01'));
    expect(result.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(result.status).toBe('REJECTED');
    expect(result.balance.amount).toBe('9999999999999999.99');
    expect((await service.getWallet(w.id)).version).toBe(1);
    expect((await consistent(w.id)).checkedEntries).toBe(1);
  });
  test('same player can have different currencies but not a duplicate currency', async () => {
    const w = await wallet();
    const usd = await service.createWallet(
      { playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'USD' } },
      context,
    );
    expect(usd.id).not.toBe(w.id);
    expect(usd.balance.currency).toBe('USD');
    await consistent(w.id);
    await consistent(usd.id);
  });
  test('concurrent distinct refunds of one BET create only one credit', async () => {
    const w = await wallet(),
      bet = input(w);
    await submit(bet);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        submit(input(w, 'REFUND', '10.00', bet.externalTransactionId)),
      ),
    );
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(19);
    expect((await service.getWallet(w.id)).balance.amount).toBe('100.00');
    expect((await consistent(w.id)).checkedEntries).toBe(3);
  });
  test('conflicting key across different wallets never moves both balances', async () => {
    const a = await wallet(),
      b = await wallet(),
      key = crypto.randomUUID();
    const results = await Promise.allSettled([submit(input(a), key), submit(input(b), key)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('IDEMPOTENCY_CONFLICT');
    const balances = await Promise.all([service.getWallet(a.id), service.getWallet(b.id)]);
    expect(balances.map((w) => w.balance.amount).sort()).toEqual(['100.00', '90.00']);
    await consistent(a.id);
    await consistent(b.id);
  });
  test('pending inbox replay reflects final result after reference recovery', async () => {
    const w = await wallet(),
      bet = input(w),
      refund = input(w, 'REFUND', '10.00', bet.externalTransactionId);
    const ctx = { ...context, messageId: crypto.randomUUID() };
    expect((await service.submit(refund, refund.externalTransactionId, ctx)).status).toBe(
      'PENDING_REFERENCE',
    );
    await submit(bet);
    await orm.em
      .fork()
      .execute(
        'UPDATE wager_transactions SET next_attempt_at=now() WHERE wallet_id=? AND status=?',
        [w.id, 'PENDING_REFERENCE'],
      );
    await service.retryReferences();
    const replay = await service.submit(refund, refund.externalTransactionId, ctx);
    expect(replay.status).toBe('PROCESSED');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('100.00');
    expect((await consistent(w.id)).checkedEntries).toBe(3);
  });
  test('reconciliation reports corruption without silently repairing the balance', async () => {
    const w = await wallet();
    // Deliberately bypass constraints only in this disposable test database.
    async function forceBalance(amount: string) {
      await orm.em.fork().transactional(async (em) => {
        await em.execute('SET LOCAL session_replication_role=replica');
        await em.execute('UPDATE wallets SET balance=? WHERE id=?', [amount, w.id]);
      });
    }
    try {
      await forceBalance('90.00');
      const result = await service.reconcile(w.id, context);
      expect(result.consistent).toBe(false);
      expect(result.difference.amount).toBe('-10.00');
      expect(result.calculatedBalance.amount).toBe('100.00');
      expect((await service.getWallet(w.id)).balance.amount).toBe('90.00');
      const metricsResponse = await fetch(`${base}/metrics`);
      expect(await metricsResponse.text()).toContain('wager_reconciliation_mismatches_total 1');
    } finally {
      await forceBalance('100.00');
    }
    await consistent(w.id);
  });
  test('SQS outage fails readiness but keeps liveness available', async () => {
    const endpoint = process.env.SQS_ENDPOINT;
    process.env.SQS_ENDPOINT = 'http://127.0.0.1:1';
    const unavailable = new Queues();
    if (endpoint === undefined) delete process.env.SQS_ENDPOINT;
    else process.env.SQS_ENDPOINT = endpoint;
    Object.assign(unavailable, { input: queues.input, events: queues.events, dlq: queues.dlq });
    const api = await createApi(service, unavailable);
    try {
      await api.listen(0, '127.0.0.1');
      const url = await api.getUrl();
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
      expect((await fetch(`${url}/health/ready`)).status).toBe(503);
    } finally {
      await api.close();
      unavailable.close();
    }
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  });
  test('unreachable PostgreSQL returns 503 for readiness and financial requests', async () => {
    const { MikroORM } = await import('@mikro-orm/postgresql');
    const unavailable = await MikroORM.init({
      ...orm.config.getAll(),
      clientUrl: 'postgresql://jungle:jungle@127.0.0.1:1/jungle',
      host: '127.0.0.1',
      port: 1,
      connect: false,
      pool: { min: 0, max: 1, acquireTimeoutMillis: 1000 },
    });
    const api = await createApi(new WageringService(unavailable), queues);
    try {
      await api.listen(0, '127.0.0.1');
      const url = await api.getUrl();
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
      expect((await fetch(`${url}/health/ready`)).status).toBe(503);
      const response = await fetch(`${url}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '1.00', currency: 'BRL' },
        }),
      });
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe('TEMPORARY_UNAVAILABLE');
    } finally {
      await api.close();
      await unavailable.close();
    }
  });
  test('real lock timeout returns HTTP 503 and allows retry with the same key', async () => {
    const w = await wallet(),
      p = input(w);
    let unlock!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id=? FOR UPDATE', [w.id]);
      locked();
      await gate;
    });
    await acquired;
    try {
      const response = await fetch(`${base}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': p.externalTransactionId },
        body: JSON.stringify(p),
      });
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe('TEMPORARY_UNAVAILABLE');
      expect((await service.getWallet(w.id)).balance.amount).toBe('100.00');
    } finally {
      unlock();
      await holding;
    }
    expect((await submit(p)).status).toBe('PROCESSED');
    expect((await consistent(w.id)).calculatedBalance.amount).toBe('90.00');
  });
  test('SIGTERM completes a message already waiting on a wallet lock', async () => {
    const prefix = 'shutdown-' + crypto.randomUUID().slice(0, 8) + '-';
    const previous = process.env.QUEUE_PREFIX;
    process.env.QUEUE_PREFIX = prefix;
    const isolated = new Queues();
    try {
      await isolated.initialize();
    } finally {
      if (previous === undefined) delete process.env.QUEUE_PREFIX;
      else process.env.QUEUE_PREFIX = previous;
    }
    const w = await wallet(),
      p = input(w),
      messageId = crypto.randomUUID();
    const url = new URL(process.env.DATABASE_URL!);
    let unlock!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id=? FOR UPDATE', [w.id]);
      locked();
      await gate;
    });
    await acquired;
    const childProcess = Bun.spawn([process.execPath, 'src/worker.ts'], {
      env: {
        ...process.env,
        QUEUE_PREFIX: prefix,
        DATABASE_URL: url.toString(),
        WORKER_HEALTH_PORT: '0',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    try {
      await isolated.client.send(
        new SendMessageCommand({
          QueueUrl: isolated.input,
          MessageGroupId: w.id,
          MessageDeduplicationId: messageId,
          MessageBody: JSON.stringify({
            messageId,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: { ...p, idempotencyKey: p.externalTransactionId },
          }),
        }),
      );
      await waitFor(
        async () =>
          (
            await orm.em
              .fork()
              .execute(
                "SELECT pid FROM pg_stat_activity WHERE datname=? AND wait_event_type='Lock' AND query LIKE '%FROM wallets%FOR UPDATE%'",
                [testDatabase],
              )
          ).length > 0,
      );
      childProcess.kill('SIGTERM');
      unlock();
      await holding;
      await waitFor(async () => childProcess.exitCode !== null, 15000);
      expect(await childProcess.exited).toBe(0);
      expect((await consistent(w.id)).calculatedBalance.amount).toBe('90.00');
      expect(
        await orm.em
          .fork()
          .execute('SELECT message_id FROM inbox WHERE message_id=? AND processed_at IS NOT NULL', [
            messageId,
          ]),
      ).toHaveLength(1);
      const remaining = await isolated.client.send(
        new ReceiveMessageCommand({ QueueUrl: isolated.input, WaitTimeSeconds: 1 }),
      );
      expect(remaining.Messages ?? []).toHaveLength(0);
    } finally {
      unlock();
      await holding;
      if (childProcess.exitCode === null) childProcess.kill('SIGKILL');
      await childProcess.exited;
      await Promise.all(
        [isolated.input, isolated.events, isolated.dlq].map((QueueUrl) =>
          isolated.client.send(new DeleteQueueCommand({ QueueUrl })),
        ),
      );
      isolated.close();
    }
  });
});
