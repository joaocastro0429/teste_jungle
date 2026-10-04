import type { MoneyProps } from './money';
import type { LedgerDirection, Wallet, WalletLedgerEntry } from './wallet';
import type { WagerTransaction } from './transaction';
export interface EventContext {
  correlationId: string;
  causationId?: string;
}
interface EventProps<T> extends EventContext {
  eventId: string;
  aggregateId: string;
  occurredAt: Date;
  data: T;
}
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  protected constructor(protected readonly props: EventProps<T>) {
    Object.freeze(props.data);
  }
  toJSON() {
    return {
      ...this.props,
      eventType: this.eventType,
      version: this.version,
      occurredAt: this.props.occurredAt.toISOString(),
    };
  }
}
interface TransactionEventData {
  transactionId: string;
  walletId: string;
  status: string;
  failureCode?: string;
}
function transactionProps(
  tx: WagerTransaction,
  ctx: EventContext,
): EventProps<TransactionEventData> {
  return {
    ...ctx,
    eventId: crypto.randomUUID(),
    aggregateId: tx.walletId,
    occurredAt: new Date(),
    data: {
      transactionId: tx.id,
      walletId: tx.walletId,
      status: tx.status,
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    },
  };
}
export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext) {
    return new this(transactionProps(tx, ctx));
  }
}
export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext) {
    return new this(transactionProps(tx, ctx));
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext) {
    return new this(transactionProps(tx, ctx));
  }
}
interface BalanceData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<BalanceData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext) {
    return new this({
      ...ctx,
      eventId: crypto.randomUUID(),
      aggregateId: wallet.id,
      occurredAt: new Date(),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    private _processedAt?: Date,
  ) {}
  static receive(props: { messageId: string; consumerName: string; payloadHash: string }) {
    return new this(props.messageId, props.consumerName, props.payloadHash);
  }
  static rehydrate(props: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    processedAt?: Date;
  }) {
    return new this(props.messageId, props.consumerName, props.payloadHash, props.processedAt);
  }
  isProcessed() {
    return !!this._processedAt;
  }
  markProcessed(at: Date) {
    if (this.isProcessed()) throw new Error('INBOX_ALREADY_PROCESSED');
    this._processedAt = at;
  }
  get processedAt() {
    return this._processedAt;
  }
}
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly payload: Readonly<Record<string, unknown>>,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}
  static enqueue(event: IntegrationEvent<unknown>) {
    const payload = event.toJSON();
    return new this(payload.eventId, payload, 0);
  }
  static rehydrate(props: {
    id: string;
    payload: Record<string, unknown>;
    attempts: number;
    nextAttemptAt?: Date;
    publishedAt?: Date;
  }) {
    return new this(
      props.id,
      props.payload,
      props.attempts,
      props.nextAttemptAt,
      props.publishedAt,
    );
  }
  get attempts() {
    return this._attempts;
  }
  get nextAttemptAt() {
    return this._nextAttemptAt;
  }
  get publishedAt() {
    return this._publishedAt;
  }
  isPending() {
    return !this._publishedAt;
  }
  isDue(now: Date) {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now);
  }
  markPublished(at: Date) {
    this._publishedAt = at;
  }
  scheduleRetry(now: Date) {
    this._attempts++;
    this._nextAttemptAt = new Date(
      now.getTime() + Math.min(60, 2 ** Math.min(this._attempts, 6)) * 1000,
    );
  }
}
