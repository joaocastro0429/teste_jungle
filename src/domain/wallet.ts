import { Money } from './money';
import { DomainError } from './errors';
export type LedgerDirection = 'DEBIT' | 'CREDIT';
export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export class Wallet {
  private constructor(private readonly state: WalletState) {}
  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (props.initialBalance.isNegative()) throw new DomainError('NEGATIVE_BALANCE');
    const now = new Date();
    return new Wallet({
      ...props,
      balance: props.initialBalance,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  static rehydrate(state: WalletState): Wallet {
    return new Wallet({ ...state });
  }
  get id(): string {
    return this.state.id;
  }
  get playerId(): string {
    return this.state.playerId;
  }
  get currency(): string {
    return this.balance.currency;
  }
  get balance(): Money {
    return this.state.balance;
  }
  get version(): number {
    return this.state.version;
  }
  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }
  get updatedAt(): Date {
    return new Date(this.state.updatedAt);
  }
  debit(money: Money, failureCode = 'INSUFFICIENT_FUNDS'): void {
    if (money.isNegative()) throw new DomainError('INVALID_AMOUNT');
    if (this.balance.isLessThan(money)) throw new DomainError(failureCode);
    this.change(this.balance.subtract(money));
  }
  credit(money: Money): void {
    if (money.isNegative()) throw new DomainError('INVALID_AMOUNT');
    this.change(this.balance.add(money));
  }
  private change(next: Money): void {
    if (!next.equals(this.balance)) {
      this.state.balance = next;
      this.state.version++;
      this.state.updatedAt = new Date();
    }
  }
  toJSON() {
    return {
      id: this.id,
      playerId: this.playerId,
      balance: this.balance.toJSON(),
      version: this.version,
    };
  }
}
export interface LedgerState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}
export class WalletLedgerEntry {
  private constructor(private readonly state: LedgerState) {
    Object.freeze(state);
    Object.freeze(this);
  }
  static create(state: LedgerState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry({ ...state });
    if (state.money.isNegative() || !entry.isBalanced()) throw new DomainError('UNBALANCED_LEDGER');
    return entry;
  }
  static rehydrate(state: LedgerState): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...state });
  }
  get id() {
    return this.state.id;
  }
  get walletId() {
    return this.state.walletId;
  }
  get transactionId() {
    return this.state.transactionId;
  }
  get direction() {
    return this.state.direction;
  }
  get money() {
    return this.state.money;
  }
  get balanceBefore() {
    return this.state.balanceBefore;
  }
  get balanceAfter() {
    return this.state.balanceAfter;
  }
  get createdAt() {
    return new Date(this.state.createdAt);
  }
  isBalanced(): boolean {
    const s = this.state;
    return (
      s.direction === 'CREDIT' ? s.balanceBefore.add(s.money) : s.balanceBefore.subtract(s.money)
    ).equals(s.balanceAfter);
  }
}
