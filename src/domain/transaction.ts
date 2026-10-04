import { DomainError } from './errors';
import { Money, type MoneyProps } from './money';
import type { LedgerDirection, Wallet } from './wallet';
export type Kind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type Status = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export interface WagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<Kind, 'OPENING'>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export interface TransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: Status;
  failureCode?: string;
  createdAt: Date;
  processedAt?: Date;
}
export class WagerTransaction {
  private constructor(private readonly state: TransactionState) {}
  static create(state: Omit<TransactionState, 'status'>): WagerTransaction {
    if (['REFUND', 'ROLLBACK'].includes(state.kind) && !state.referenceExternalTransactionId)
      throw new DomainError('REFERENCE_REQUIRED');
    if (state.money.isNegative()) throw new DomainError('INVALID_AMOUNT');
    if (state.kind !== 'LOSS' && !state.money.isPositive())
      throw new DomainError('AMOUNT_MUST_BE_POSITIVE');
    if (state.kind === 'LOSS' && !state.money.isZero())
      throw new DomainError('LOSS_AMOUNT_MUST_BE_ZERO');
    return new WagerTransaction({ ...state, status: 'PENDING' });
  }
  static rehydrate(state: TransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }
  get id() {
    return this.state.id;
  }
  get providerId() {
    return this.state.providerId;
  }
  get externalTransactionId() {
    return this.state.externalTransactionId;
  }
  get walletId() {
    return this.state.walletId;
  }
  get playerId() {
    return this.state.playerId;
  }
  get roundId() {
    return this.state.roundId;
  }
  get kind() {
    return this.state.kind;
  }
  get money() {
    return this.state.money;
  }
  get status() {
    return this.state.status;
  }
  get referenceTransactionId() {
    return this.state.referenceTransactionId;
  }
  get referenceExternalTransactionId() {
    return this.state.referenceExternalTransactionId;
  }
  get failureCode() {
    return this.state.failureCode;
  }
  get processedAt() {
    return this.state.processedAt ? new Date(this.state.processedAt) : undefined;
  }
  isTerminal(): boolean {
    return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status);
  }
  private assertMutable(): void {
    if (this.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE');
  }
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    this.state.status = 'PROCESSED';
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.processedAt = at;
  }
  markPendingReference(): void {
    this.assertMutable();
    this.state.status = 'PENDING_REFERENCE';
  }
  reject(code: string): void {
    this.assertMutable();
    this.state.status = 'REJECTED';
    this.state.failureCode = code;
    this.state.processedAt = new Date();
  }
  fail(code: string): void {
    this.assertMutable();
    this.state.status = 'FAILED';
    this.state.failureCode = code;
    this.state.processedAt = new Date();
  }
  affectsBalance(): boolean {
    return this.kind !== 'LOSS';
  }
  requiresReference(): boolean {
    return this.kind === 'REFUND' || this.kind === 'ROLLBACK';
  }
  matchesPayload(hash: string): boolean {
    return this.state.payloadHash === hash;
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === 'BET') return 'DEBIT';
    if (this.kind === 'ROLLBACK') {
      if (!reference) throw new DomainError('REFERENCE_REQUIRED');
      return reference.kind === 'BET' ? 'CREDIT' : 'DEBIT';
    }
    return 'CREDIT';
  }
  validateWallet(wallet: Wallet): void {
    if (this.playerId !== wallet.playerId) throw new DomainError('PLAYER_MISMATCH');
    if (this.money.currency !== wallet.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
  validateReference(ref: WagerTransaction): void {
    if (
      ref.providerId !== this.providerId ||
      ref.playerId !== this.playerId ||
      ref.walletId !== this.walletId ||
      ref.roundId !== this.roundId
    )
      throw new DomainError('REFERENCE_CONTEXT_MISMATCH');
    if (ref.money.currency !== this.money.currency) throw new DomainError('CURRENCY_MISMATCH');
    const allowed =
      this.kind === 'REFUND' || this.kind === 'WIN' || this.kind === 'LOSS'
        ? ['BET']
        : ['BET', 'WIN', 'REFUND'];
    if (!allowed.includes(ref.kind)) throw new DomainError('INVALID_REFERENCE_KIND');
    if (ref.status !== 'PROCESSED') throw new DomainError('REFERENCE_NOT_PROCESSED');
    if (this.requiresReference() && !this.money.equals(ref.money))
      throw new DomainError('REFERENCE_AMOUNT_MISMATCH');
  }
}
