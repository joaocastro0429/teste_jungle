import { createHash } from 'node:crypto';
import { DomainError } from '../domain/errors';
import { Money } from '../domain/money';
import type { WagerInput } from '../domain/transaction';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('INVALID_PAYLOAD');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value !== value.trim())
    throw new DomainError('INVALID_PAYLOAD', `Campo inválido: ${field}`);
  return value;
}
export function uuid(value: unknown, field: string): string {
  const id = text(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new DomainError('INVALID_PAYLOAD', `UUID inválido: ${field}`);
  return id.toLowerCase();
}
export function money(value: unknown): Money {
  const p = object(value);
  const m = Money.from({ amount: p.amount as string, currency: p.currency as string });
  if (!['BRL', 'USD', 'EUR'].includes(m.currency)) throw new DomainError('UNSUPPORTED_CURRENCY');
  return m;
}
export function parseWager(value: unknown): WagerInput {
  const p = object(value);
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(String(p.kind)))
    throw new DomainError('INVALID_KIND');
  const input: WagerInput = {
    providerId: text(p.providerId, 'providerId'),
    externalTransactionId: text(p.externalTransactionId, 'externalTransactionId'),
    walletId: uuid(p.walletId, 'walletId'),
    playerId: uuid(p.playerId, 'playerId'),
    roundId: text(p.roundId, 'roundId'),
    gameId: text(p.gameId, 'gameId'),
    kind: p.kind as WagerInput['kind'],
    money: money(p.money).toJSON(),
  };
  if (p.referenceExternalTransactionId !== undefined)
    input.referenceExternalTransactionId = text(
      p.referenceExternalTransactionId,
      'referenceExternalTransactionId',
    );
  return input;
}
/** Keys recursively sorted; only validated business fields, no transport metadata. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const p = value as Record<string, unknown>;
    return `{${Object.keys(p)
      .filter((k) => p[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(p[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
