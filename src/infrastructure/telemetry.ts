import { Counter, Gauge, Histogram, Registry } from 'prom-client';
export const registry = new Registry();
export const metrics = {
  transactions: new Counter({
    name: 'wager_transactions_total',
    help: 'Committed transitions',
    labelNames: ['status'],
    registers: [registry],
  }),
  duplicates: new Counter({
    name: 'wager_duplicates_total',
    help: 'Persistent replays',
    registers: [registry],
  }),
  retries: new Counter({
    name: 'wager_retries_total',
    help: 'Retry attempts',
    labelNames: ['worker'],
    registers: [registry],
  }),
  dlq: new Counter({
    name: 'wager_dlq_total',
    help: 'Messages moved to DLQ',
    registers: [registry],
  }),
  locks: new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Deadlocks and lock timeouts',
    registers: [registry],
  }),
  lag: new Gauge({
    name: 'wager_outbox_lag_seconds',
    help: 'Oldest pending event age',
    registers: [registry],
  }),
  reconciliation: new Counter({
    name: 'wager_reconciliation_mismatches_total',
    help: 'Detected balance discrepancies',
    registers: [registry],
  }),
  latency: new Histogram({
    name: 'wager_processing_seconds',
    help: 'Submission latency',
    registers: [registry],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
  }),
};
export function log(event: string, context: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...context }));
}
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String(error.code);
  return 'INFRASTRUCTURE_ERROR';
}
