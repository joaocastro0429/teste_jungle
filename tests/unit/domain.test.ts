import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet, WalletLedgerEntry } from '../../src/domain/wallet';
import { WagerTransaction, type Kind } from '../../src/domain/transaction';
import { canonical, parseWager, payloadHash } from '../../src/application/contracts';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
function tx(kind: Kind, amount: string, reference?: string) {
  return WagerTransaction.create({
    id: 'tx',
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    payloadHash: 'hash',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind,
    money: brl(amount),
    createdAt: new Date(),
    referenceExternalTransactionId: reference,
  });
}
describe('Money', () => {
  test('exact arithmetic, immutable and no rounding of invalid scale', () => {
    const a = brl('0.10');
    expect(a.add(brl('0.20')).toString()).toBe('0.30');
    expect(a.toString()).toBe('0.10');
    expect(brl('9999999999999999.99').subtract(brl('0.01')).toString()).toBe('9999999999999999.98');
    expect(brl('10.00').negate().toJSON()).toEqual({ amount: '-10.00', currency: 'BRL' });
    expect(brl('10.00').subtract(brl('10.00')).isZero()).toBe(true);
  });
  test.each([
    'NaN',
    'Infinity',
    '1e3',
    '',
    '-1.00',
    '1.001',
    '1',
    '1.0',
    ' 1.00',
    '01.00',
    '10000000000000000.00',
  ])('reject %s', (value) => expect(() => brl(value)).toThrow());
  test('reject numeric input and invalid currency', () => {
    expect(() => Money.from({ amount: 1 as unknown as string, currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow();
  });
  test('currency conflict', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    for (const operation of [
      () => brl('1.00').add(usd),
      () => brl('1.00').subtract(usd),
      () => brl('1.00').equals(usd),
    ])
      expect(operation).toThrow('CURRENCY_MISMATCH');
  });
});
describe('Wallet and ledger', () => {
  test('balance, version and insufficient funds', () => {
    const w = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: brl('100.00') });
    expect(w.version).toBe(1);
    w.debit(brl('80.00'));
    expect(w.version).toBe(2);
    expect(() => w.debit(brl('80.00'))).toThrow('INSUFFICIENT_FUNDS');
    expect(w.balance.toString()).toBe('20.00');
    w.credit(brl('0.00'));
    expect(w.version).toBe(2);
    expect(() => w.credit(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow(
      'CURRENCY_MISMATCH',
    );
  });
  test('ledger factory validates arithmetic', () => {
    const props = {
      id: 'l',
      walletId: 'w',
      transactionId: 't',
      direction: 'DEBIT' as const,
      money: brl('10.00'),
      balanceBefore: brl('20.00'),
      balanceAfter: brl('10.00'),
      createdAt: new Date(),
    };
    expect(WalletLedgerEntry.create(props).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...props, balanceAfter: brl('9.00') })).toThrow(
      'UNBALANCED_LEDGER',
    );
  });
});
describe('Wager transitions and reversals', () => {
  test('BET/WIN/LOSS direction and balance effects', () => {
    expect(tx('BET', '1.00').ledgerDirectionFor()).toBe('DEBIT');
    expect(tx('WIN', '1.00').ledgerDirectionFor()).toBe('CREDIT');
    expect(tx('LOSS', '0.00').affectsBalance()).toBe(false);
    expect(() => tx('LOSS', '1.00')).toThrow('LOSS_AMOUNT_MUST_BE_ZERO');
    expect(() => tx('BET', '0.00')).toThrow('AMOUNT_MUST_BE_POSITIVE');
  });
  test('references and terminal states', () => {
    expect(() => tx('REFUND', '10.00')).toThrow('REFERENCE_REQUIRED');
    const bet = tx('BET', '10.00');
    bet.markProcessed(undefined, new Date());
    const refund = tx('REFUND', '10.00', 'external');
    refund.validateReference(bet);
    expect(refund.ledgerDirectionFor(bet)).toBe('CREDIT');
    const rollback = tx('ROLLBACK', '10.00', 'external');
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
    const win = tx('WIN', '10.00');
    win.markProcessed(undefined, new Date());
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
    expect(() => refund.validateReference(win)).toThrow('INVALID_REFERENCE_KIND');
    expect(() => tx('REFUND', '9.00', 'external').validateReference(bet)).toThrow(
      'REFERENCE_AMOUNT_MISMATCH',
    );
    expect(() => bet.reject('error')).toThrow('INVALID_TRANSACTION_STATE');
    const rejected = tx('BET', '1.00');
    rejected.reject('INSUFFICIENT_FUNDS');
    expect(() => rejected.markProcessed(undefined, new Date())).toThrow();
    const failed = tx('BET', '1.00');
    failed.fail('PERMANENT_ERROR');
    expect(failed.isTerminal()).toBe(true);
    expect(() => failed.markPendingReference()).toThrow();
  });
  test('canonical payload stable and divergent hash differs', () => {
    expect(canonical({ b: 1, a: { z: 2, y: 3 } })).toBe(canonical({ a: { y: 3, z: 2 }, b: 1 }));
    expect(payloadHash({ amount: '1.00' })).not.toBe(payloadHash({ amount: '2.00' }));
    expect(tx('BET', '1.00').matchesPayload('other')).toBe(false);
  });
});
