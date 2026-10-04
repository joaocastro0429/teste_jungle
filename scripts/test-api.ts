import assert from 'node:assert/strict';

// Cria somente jogadores e carteiras novos. Os dados ficam disponíveis para consulta.
const base = process.env.API_URL ?? 'http://localhost:3000';
async function request(path: string, body?: unknown, key?: string) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { http: response.status, data: await response.json() };
}
function check(label: string, result: Awaited<ReturnType<typeof request>>, http: number) {
  assert.equal(result.http, http, `${label}: ${JSON.stringify(result)}`);
  console.log(`OK — ${label} (HTTP ${http})`);
}
async function wallet() {
  const playerId = crypto.randomUUID();
  const result = await request('/wallets', {
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  check('Criar carteira com 100.00', result, 201);
  assert.equal(result.data.balance.amount, '100.00');
  return { playerId, walletId: result.data.id as string };
}
function wager(context: { playerId: string; walletId: string }, amount: string) {
  return {
    ...context,
    providerId: 'entrevista-api',
    externalTransactionId: crypto.randomUUID(),
    roundId: 'round-entrevista',
    gameId: 'game-entrevista',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}
async function submit(input: ReturnType<typeof wager>, key = input.externalTransactionId) {
  return request('/wagering/transactions', input, key);
}
async function balance(id: string, expected: string) {
  const result = await request(`/wallets/${id}`);
  assert.equal(result.http, 200);
  assert.equal(result.data.balance.amount, expected);
}

check('Infraestrutura pronta', await request('/health/ready'), 200);
const context = await wallet();
const bet = wager(context, '25.00');
const first = await submit(bet);
check('Aposta válida', first, 200);
assert.equal(first.data.status, 'PROCESSED');
assert.equal(first.data.balance.amount, '75.00');

const replay = await submit(bet);
check('Repetição com mesma chave e conteúdo', replay, 200);
assert.equal(replay.data.idempotentReplay, true);
assert.equal(replay.data.transactionId, first.data.transactionId);
await balance(context.walletId, '75.00');

const conflict = await submit({ ...bet, money: { amount: '30.00', currency: 'BRL' } });
check('Mesma chave com conteúdo diferente', conflict, 409);
assert.equal(conflict.data.code, 'IDEMPOTENCY_CONFLICT');

check('Chave de idempotência ausente', await request('/wagering/transactions', bet), 400);
check('Valor sem duas casas decimais', await submit(wager(context, '1.234')), 400);
const insufficient = await submit(wager(context, '80.00'));
check('Saldo insuficiente', insufficient, 422);
assert.equal(insufficient.data.failureCode, 'INSUFFICIENT_FUNDS');
const currency = await submit({
  ...wager(context, '1.00'),
  money: { amount: '1.00', currency: 'USD' },
});
check('Moeda diferente da carteira', currency, 422);
assert.equal(currency.data.failureCode, 'CURRENCY_MISMATCH');
await balance(context.walletId, '75.00');

const refund = {
  ...wager(context, '25.00'),
  kind: 'REFUND',
  referenceExternalTransactionId: bet.externalTransactionId,
};
check('Reembolso da aposta original', await submit(refund), 200);
await balance(context.walletId, '100.00');
const duplicateRefund = await submit({ ...refund, externalTransactionId: crypto.randomUUID() });
check('Segundo reembolso da mesma aposta', duplicateRefund, 422);
assert.equal(duplicateRefund.data.failureCode, 'ALREADY_REVERSED');
await balance(context.walletId, '100.00');

check(
  'Consultar transação por ID',
  await request(`/wagering/transactions/${first.data.transactionId}`),
  200,
);
const ledger = await request(`/wallets/${context.walletId}/ledger`);
check('Histórico contém abertura, aposta e reembolso', ledger, 200);
assert.equal(ledger.data.items.length, 3);
const reconciliation = await request(`/wallets/${context.walletId}/reconciliation`, {});
check('Reconciliação após operações', reconciliation, 200);
assert.equal(reconciliation.data.consistent, true);
assert.equal(reconciliation.data.difference.amount, '0.00');
assert.equal(reconciliation.data.calculatedBalance.amount, '100.00');

const concurrent = await wallet();
const results = await Promise.all([
  submit(wager(concurrent, '80.00')),
  submit(wager(concurrent, '80.00')),
]);
assert.deepEqual(results.map((r) => r.http).sort(), [200, 422]);
assert.equal(results.filter((r) => r.data.status === 'PROCESSED').length, 1);
assert.equal(results.filter((r) => r.data.failureCode === 'INSUFFICIENT_FUNDS').length, 1);
await balance(concurrent.walletId, '20.00');
const concurrentLedger = await request(`/wallets/${concurrent.walletId}/ledger`);
assert.equal(concurrentLedger.http, 200);
assert.equal(concurrentLedger.data.items.length, 2);
console.log('OK — duas apostas simultâneas: um débito, uma rejeição e saldo 20.00');
const final = await request(`/wallets/${concurrent.walletId}/reconciliation`, {});
assert.equal(final.http, 200);
assert.equal(final.data.consistent, true);
assert.equal(final.data.calculatedBalance.amount, '20.00');
console.log(`\nTodos os cenários passaram. API: ${base}`);
console.log(`Carteira para consultar no Postman: ${context.walletId}`);
console.log(`Carteira do teste concorrente: ${concurrent.walletId}`);

export {};
