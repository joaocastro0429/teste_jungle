import 'reflect-metadata';
import { EntitySchema } from '@mikro-orm/core';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import {
  WagerTransaction,
  type TransactionState,
  type Status,
  type Kind,
} from '../domain/transaction';
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
const walletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string' },
    balance: { type: 'string', columnType: 'numeric(18,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    updatedAt: { type: 'Date', fieldName: 'updated_at' },
  },
});
export async function connectDatabase(): Promise<MikroORM> {
  return MikroORM.init({
    entities: [walletSchema],
    clientUrl: process.env.DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:55432/jungle',
    pool: { min: 0, max: 12 },
    allowGlobalContext: false,
  });
}
export type Sql = EntityManager;
export function walletFromRow(row: Record<string, unknown>): Wallet {
  return Wallet.rehydrate({
    id: String(row.id),
    playerId: String(row.player_id),
    balance: Money.rehydrate(String(row.balance), String(row.currency)),
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  });
}
export interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: Kind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: Status;
  failure_code: string | null;
  response: Result | null;
  created_at: Date;
  processed_at: Date | null;
  attempts: number;
}
export interface Result {
  transactionId: string;
  status: Status;
  balance: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay: boolean;
}
export function transactionFromRow(row: TransactionRow): WagerTransaction {
  const state: TransactionState = {
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: Money.rehydrate(row.amount, row.currency),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    status: row.status,
    failureCode: row.failure_code ?? undefined,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  };
  return WagerTransaction.rehydrate(state);
}
