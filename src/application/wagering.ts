import type { MikroORM } from '@mikro-orm/postgresql';
import { ConflictError, DomainError, NotFoundError } from '../domain/errors';
import { Money } from '../domain/money';
import { Wallet, WalletLedgerEntry } from '../domain/wallet';
import { WagerTransaction } from '../domain/transaction';
import {
  IntegrationEvent,
  InboxMessage,
  OutboxMessage,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from '../domain/events';
import {
  WalletRecord,
  transactionFromRow,
  walletFromRow,
  type Result,
  type Sql,
  type TransactionRow,
} from '../infrastructure/database';
import { errorCode, log, metrics } from '../infrastructure/telemetry';
import { money, object, parseWager, payloadHash, text, uuid } from './contracts';
export interface SubmissionContext extends EventContext {
  messageId?: string;
  consumerName?: string;
}
export class WageringService {
  constructor(readonly orm: MikroORM) {}
  private async atomic<T>(work: (em: Sql) => Promise<T>): Promise<T> {
    // Local retry is bounded; infrastructure errors bubble to HTTP/SQS retry policy.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(async (em) => {
          await em.execute("SET LOCAL lock_timeout = '5s'");
          return work(em);
        });
      } catch (error) {
        if (['40P01', '40001', '55P03'].includes(errorCode(error))) {
          metrics.locks.inc();
          if (attempt < 2) {
            await Bun.sleep(20 * (attempt + 1));
            continue;
          }
        }
        throw error;
      }
    }
  }
  async createWallet(value: unknown, ctx: EventContext) {
    const p = object(value),
      playerId = uuid(p.playerId, 'playerId'),
      initialBalance = money(p.initialBalance);
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId, initialBalance });
    try {
      await this.atomic(async (em) => {
        // Use the ORM mapping for normal persistence; explicit SQL for contention-sensitive operations.
        const record = em.create(WalletRecord, {
          id: wallet.id,
          playerId,
          currency: wallet.currency,
          balance: wallet.balance.toString(),
          version: 1,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });
        em.persist(record);
        await em.flush();
        if (initialBalance.isPositive()) {
          const id = crypto.randomUUID();
          await em.execute(
            `INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,processed_at,response)
            VALUES (?, '__internal__', ?, ?, ?, ?, ?, '__opening__', '__opening__', 'OPENING', ?, ?, 'PROCESSED', now(), ?::jsonb)`,
            [
              id,
              id,
              `opening:${wallet.id}`,
              payloadHash({ walletId: wallet.id }),
              wallet.id,
              playerId,
              initialBalance.toString(),
              wallet.currency,
              JSON.stringify({
                transactionId: id,
                status: 'PROCESSED',
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
              }),
            ],
          );
          const entry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: wallet.id,
            transactionId: id,
            direction: 'CREDIT',
            money: initialBalance,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: wallet.balance,
            createdAt: new Date(),
          });
          await this.insertLedger(em, entry);
          const rows = await em.execute<TransactionRow[]>(
            'SELECT * FROM wager_transactions WHERE id=?',
            [id],
          );
          await this.enqueue(em, WagerTransactionProcessed.from(transactionFromRow(rows[0]!), ctx));
          await this.enqueue(em, WalletBalanceChanged.from(wallet, entry, ctx));
        }
      });
    } catch (error) {
      if (errorCode(error) === '23505') throw new ConflictError('WALLET_ALREADY_EXISTS');
      throw error;
    }
    return wallet.toJSON();
  }
  async submit(value: unknown, keyValue: unknown, ctx: SubmissionContext): Promise<Result> {
    const stop = metrics.latency.startTimer();
    try {
      const input = parseWager(value),
        key = text(keyValue, 'Idempotency-Key'),
        hash = payloadHash(input);
      if (input.providerId === '__internal__') throw new DomainError('RESERVED_PROVIDER');
      const candidate = WagerTransaction.create({
        ...input,
        money: Money.from(input.money),
        id: crypto.randomUUID(),
        idempotencyKey: key,
        payloadHash: hash,
        createdAt: new Date(),
      });
      const result = await this.atomic(async (em) => {
        const identities = await em.execute<TransactionRow[]>(
          'SELECT * FROM wager_transactions WHERE idempotency_key=? OR (provider_id=? AND external_transaction_id=?)',
          [key, input.providerId, input.externalTransactionId],
        );
        if (
          identities.length &&
          (identities.length !== 1 ||
            identities[0]!.idempotency_key !== key ||
            identities[0]!.payload_hash !== hash)
        )
          throw new ConflictError('IDEMPOTENCY_CONFLICT');
        const wallets = await em.execute<Record<string, unknown>[]>(
          'SELECT * FROM wallets WHERE id=? FOR UPDATE',
          [input.walletId],
        );
        if (!wallets.length) throw new NotFoundError('WALLET_NOT_FOUND');
        const wallet = walletFromRow(wallets[0]!);
        if (ctx.messageId) {
          const consumer = ctx.consumerName ?? 'wager-consumer';
          // Envelope includes idempotencyKey: reusing messageId with a different key is also a conflict.
          const inboxHash = payloadHash({ input, key });
          await em.execute(
            'INSERT INTO inbox(consumer_name,message_id,payload_hash) VALUES (?,?,?) ON CONFLICT DO NOTHING',
            [consumer, ctx.messageId, inboxHash],
          );
          const inbox = (
            await em.execute<
              { payload_hash: string; processed_at: Date | null; response: Result }[]
            >('SELECT * FROM inbox WHERE consumer_name=? AND message_id=? FOR UPDATE', [
              consumer,
              ctx.messageId,
            ])
          )[0]!;
          if (inbox.payload_hash !== inboxHash) throw new ConflictError('INBOX_PAYLOAD_CONFLICT');
          if (inbox.processed_at) {
            const current = (
              await em.execute<TransactionRow[]>('SELECT * FROM wager_transactions WHERE id=?', [
                inbox.response.transactionId,
              ])
            )[0];
            return { ...(current?.response ?? inbox.response), idempotentReplay: true };
          }
        }
        const inserted = await em.execute<{ id: string }[]>(
          `INSERT INTO wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,reference_external_transaction_id,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING') ON CONFLICT DO NOTHING RETURNING id`,
          [
            candidate.id,
            input.providerId,
            input.externalTransactionId,
            key,
            hash,
            wallet.id,
            input.playerId,
            input.roundId,
            input.gameId,
            input.kind,
            input.money.amount,
            input.money.currency,
            input.referenceExternalTransactionId ?? null,
          ],
        );
        let response: Result;
        if (!inserted.length) {
          const existing = await em.execute<TransactionRow[]>(
            `SELECT * FROM wager_transactions WHERE idempotency_key=? OR (provider_id=? AND external_transaction_id=?)`,
            [key, input.providerId, input.externalTransactionId],
          );
          if (
            existing.length !== 1 ||
            existing[0]!.idempotency_key !== key ||
            existing[0]!.payload_hash !== hash
          )
            throw new ConflictError('IDEMPOTENCY_CONFLICT');
          response = { ...existing[0]!.response!, idempotentReplay: true };
        } else {
          response = await this.apply(em, candidate, wallet, ctx, 0);
        }
        if (ctx.messageId) {
          const inbox = InboxMessage.receive({
            messageId: ctx.messageId,
            consumerName: ctx.consumerName ?? 'wager-consumer',
            payloadHash: hash,
          });
          inbox.markProcessed(new Date());
          await em.execute(
            'UPDATE inbox SET processed_at=?, response=?::jsonb WHERE consumer_name=? AND message_id=?',
            [inbox.processedAt, JSON.stringify(response), inbox.consumerName, inbox.messageId],
          );
        }
        return response;
      });
      if (result.idempotentReplay) metrics.duplicates.inc();
      else metrics.transactions.inc({ status: result.status });
      log('wager_submission', {
        correlationId: ctx.correlationId,
        messageId: ctx.messageId,
        transactionId: result.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        status: result.status,
        replay: result.idempotentReplay,
      });
      return result;
    } finally {
      stop();
    }
  }
  private async apply(
    em: Sql,
    tx: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
    attempts: number,
  ): Promise<Result> {
    let reference: WagerTransaction | undefined, entry: WalletLedgerEntry | undefined;
    try {
      tx.validateWallet(wallet);
      if (tx.referenceExternalTransactionId) {
        const rows = await em.execute<TransactionRow[]>(
          'SELECT * FROM wager_transactions WHERE provider_id=? AND external_transaction_id=?',
          [tx.providerId, tx.referenceExternalTransactionId],
        );
        if (!rows.length || ['PENDING', 'PENDING_REFERENCE'].includes(rows[0]!.status)) {
          // Validate context even when reference exists but is pending.
          if (rows.length) {
            const ref = transactionFromRow(rows[0]!);
            if (
              ref.walletId !== tx.walletId ||
              ref.playerId !== tx.playerId ||
              ref.roundId !== tx.roundId
            )
              throw new DomainError('REFERENCE_CONTEXT_MISMATCH');
          }
          tx.markPendingReference();
          if (attempts === 0)
            await this.enqueue(em, WagerTransactionPendingReference.from(tx, ctx));
        } else {
          reference = transactionFromRow(rows[0]!);
          tx.validateReference(reference);
          if (tx.requiresReference()) {
            const reversals = await em.execute<{ id: string }[]>(
              `SELECT id FROM wager_transactions WHERE reference_transaction_id=? AND kind=? AND status='PROCESSED'`,
              [reference.id, tx.kind],
            );
            if (reversals.length) throw new DomainError('ALREADY_REVERSED');
          }
        }
      }
      if (tx.status !== 'PENDING_REFERENCE') {
        if (tx.affectsBalance()) {
          const before = wallet.balance,
            direction = tx.ledgerDirectionFor(reference);
          if (direction === 'DEBIT')
            wallet.debit(
              tx.money,
              tx.kind === 'ROLLBACK' ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS',
            );
          else wallet.credit(tx.money);
          // Reject overflow as a business failure before PostgreSQL numeric(18,2) would fail.
          if (wallet.balance.toString().split('.')[0]!.length > 16)
            throw new DomainError('BALANCE_LIMIT_EXCEEDED');
          entry = WalletLedgerEntry.create({
            id: crypto.randomUUID(),
            walletId: wallet.id,
            transactionId: tx.id,
            direction,
            money: tx.money,
            balanceBefore: before,
            balanceAfter: wallet.balance,
            createdAt: new Date(),
          });
        }
        tx.markProcessed(reference?.id, new Date());
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      tx.reject(error.code);
      // A failed movement must not leak its in-memory balance.
      const original = (
        await em.execute<Record<string, unknown>[]>('SELECT * FROM wallets WHERE id=?', [wallet.id])
      )[0]!;
      wallet = walletFromRow(original);
      entry = undefined;
    }
    const response: Result = {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    };
    await em.execute(
      `UPDATE wager_transactions SET status=?,reference_transaction_id=?,failure_code=?,processed_at=?,response=?::jsonb,
      attempts=?,next_attempt_at=now()+(? * interval '1 second') WHERE id=?`,
      [
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.processedAt ?? null,
        JSON.stringify(response),
        attempts,
        Math.min(60, 2 ** Math.min(attempts, 6)),
        tx.id,
      ],
    );
    if (entry) {
      await em.execute('UPDATE wallets SET balance=?,version=?,updated_at=? WHERE id=?', [
        wallet.balance.toString(),
        wallet.version,
        wallet.updatedAt,
        wallet.id,
      ]);
      await this.insertLedger(em, entry);
      await this.enqueue(em, WalletBalanceChanged.from(wallet, entry, ctx));
    }
    if (tx.status === 'PROCESSED') await this.enqueue(em, WagerTransactionProcessed.from(tx, ctx));
    if (tx.status === 'REJECTED') await this.enqueue(em, WagerTransactionRejected.from(tx, ctx));
    return response;
  }
  private async insertLedger(em: Sql, entry: WalletLedgerEntry): Promise<void> {
    await em.execute(
      `INSERT INTO wallet_ledger(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.createdAt,
      ],
    );
  }
  private async enqueue(em: Sql, event: IntegrationEvent<unknown>): Promise<void> {
    const outbox = OutboxMessage.enqueue(event),
      payload = event.toJSON();
    await em.execute(
      'INSERT INTO outbox(id,aggregate_id,event_type,payload) VALUES (?,?,?,?::jsonb)',
      [outbox.id, payload.aggregateId, payload.eventType, JSON.stringify(outbox.payload)],
    );
  }
  async retryReferences(): Promise<number> {
    const due = await this.orm.em
      .fork()
      .execute<TransactionRow[]>(
        `SELECT * FROM wager_transactions WHERE status='PENDING_REFERENCE' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 20`,
      );
    let processed = 0;
    for (const row of due) {
      const changed = await this.atomic(async (em) => {
        // Same lock order as HTTP/SQS. SKIP LOCKED preserves progress on unrelated wallets.
        const wallets = await em.execute<Record<string, unknown>[]>(
          'SELECT * FROM wallets WHERE id=? FOR UPDATE SKIP LOCKED',
          [row.wallet_id],
        );
        if (!wallets.length) return false;
        const current = (
          await em.execute<TransactionRow[]>(
            "SELECT * FROM wager_transactions WHERE id=? AND status='PENDING_REFERENCE' AND next_attempt_at<=now()",
            [row.id],
          )
        )[0];
        if (!current) return false;
        const tx = transactionFromRow(current),
          wallet = walletFromRow(wallets[0]!);
        const ctx = { correlationId: row.id, causationId: row.id };
        const ttl = Number(process.env.REFERENCE_TTL_SECONDS ?? 300),
          max = Number(process.env.REFERENCE_MAX_ATTEMPTS ?? 10);
        if (
          current.attempts + 1 >= max ||
          Date.now() - new Date(current.created_at).getTime() >= ttl * 1000
        ) {
          tx.reject('REFERENCE_EXPIRED');
          const response: Result = {
            transactionId: tx.id,
            status: tx.status,
            balance: wallet.balance.toJSON(),
            failureCode: tx.failureCode,
            idempotentReplay: false,
          };
          await em.execute(
            'UPDATE wager_transactions SET status=?,failure_code=?,processed_at=?,response=?::jsonb WHERE id=?',
            [tx.status, tx.failureCode, tx.processedAt, JSON.stringify(response), tx.id],
          );
          await this.enqueue(em, WagerTransactionRejected.from(tx, ctx));
        } else {
          // Rehydrate as PENDING to attempt transition again, preserving all persisted identity.
          const next = transactionFromRow({ ...current, status: 'PENDING' });
          await this.apply(em, next, wallet, ctx, current.attempts + 1);
        }
        const final = (
          await em.execute<TransactionRow[]>('SELECT * FROM wager_transactions WHERE id=?', [tx.id])
        )[0]!;
        return final.status;
      });
      if (changed) {
        processed++;
        metrics.retries.inc({ worker: 'reference' });
        metrics.transactions.inc({ status: changed });
        log('reference_retry', {
          correlationId: row.id,
          transactionId: row.id,
          walletId: row.wallet_id,
          providerId: row.provider_id,
          status: changed,
        });
      }
    }
    return processed;
  }
  async getWallet(id: string) {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: uuid(id, 'walletId') });
    if (!record) throw new NotFoundError('WALLET_NOT_FOUND');
    return {
      id: record.id,
      playerId: record.playerId,
      balance: { amount: record.balance, currency: record.currency },
      version: record.version,
    };
  }
  async getTransaction(id: string) {
    return this.queryTransaction('id=?', [uuid(id, 'transactionId')]);
  }
  async getProviderTransaction(provider: string, external: string) {
    return this.queryTransaction('provider_id=? AND external_transaction_id=?', [
      text(provider, 'providerId'),
      text(external, 'externalTransactionId'),
    ]);
  }
  private async queryTransaction(where: string, params: string[]) {
    const row = (
      await this.orm.em
        .fork()
        .execute<TransactionRow[]>(`SELECT * FROM wager_transactions WHERE ${where}`, params)
    )[0];
    if (!row) throw new NotFoundError('TRANSACTION_NOT_FOUND');
    return {
      ...row.response!,
      kind: row.kind,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      referenceTransactionId: row.reference_transaction_id,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }
  async ledger(id: string, cursor?: string, limitValue?: string) {
    await this.getWallet(id);
    const limit = limitValue === undefined ? 50 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DomainError('INVALID_LIMIT');
    let after = '0';
    if (cursor) {
      try {
        const p = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
          walletId: string;
          sequence: string;
        };
        if (
          p.walletId !== id ||
          !/^\d+$/.test(p.sequence) ||
          BigInt(p.sequence) > 9223372036854775807n
        )
          throw new Error();
        after = p.sequence;
      } catch {
        throw new DomainError('INVALID_CURSOR');
      }
    }
    const rows = await this.orm.em
      .fork()
      .execute<Record<string, unknown>[]>(
        'SELECT * FROM wallet_ledger WHERE wallet_id=? AND sequence>?::bigint ORDER BY sequence LIMIT ?',
        [id, after, limit + 1],
      );
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        createdAt: row.created_at,
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ walletId: id, sequence: String(last.sequence) })).toString(
              'base64url',
            )
          : null,
    };
  }
  async reconcile(id: string, ctx: EventContext) {
    return this.atomic(async (em) => {
      const rows = await em.execute<Record<string, unknown>[]>(
        'SELECT * FROM wallets WHERE id=? FOR UPDATE',
        [uuid(id, 'walletId')],
      );
      if (!rows.length) throw new NotFoundError('WALLET_NOT_FOUND');
      const wallet = walletFromRow(rows[0]!);
      const sum = (
        await em.execute<{ total: string; count: string }[]>(
          `SELECT COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)::numeric(18,2)::text AS total,count(*)::text AS count FROM wallet_ledger WHERE wallet_id=?`,
          [id],
        )
      )[0]!;
      const calculated = Money.rehydrate(sum.total, wallet.currency),
        difference = wallet.balance.subtract(calculated);
      if (!difference.isZero()) {
        metrics.reconciliation.inc();
        log('reconciliation_mismatch', { ...ctx, walletId: id });
      }
      return {
        walletId: id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: Number(sum.count),
      };
    });
  }
}
