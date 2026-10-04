const base = process.env.API_URL ?? 'http://localhost:3000';
async function request(path: string, body?: unknown, key?: string) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (response.status >= 500 || response.status === 400) throw new Error(JSON.stringify(result));
  return { http: response.status, ...result };
}
const playerId = crypto.randomUUID();
const wallet = await request('/wallets', {
  playerId,
  initialBalance: { amount: '100.00', currency: 'BRL' },
});
const a = {
  providerId: 'demo',
  externalTransactionId: crypto.randomUUID(),
  playerId,
  walletId: wallet.id,
  roundId: 'round-demo',
  gameId: 'game-demo',
  kind: 'BET',
  money: { amount: '80.00', currency: 'BRL' },
};
const b = { ...a, externalTransactionId: crypto.randomUUID() };
const results = await Promise.all([
  request('/wagering/transactions', a, a.externalTransactionId),
  request('/wagering/transactions', b, b.externalTransactionId),
]);
console.log(
  'Duas apostas concorrentes de 80.00 com saldo 100.00:',
  JSON.stringify(results, null, 2),
);
console.log(
  'Replay:',
  JSON.stringify(await request('/wagering/transactions', a, a.externalTransactionId), null, 2),
);
console.log(
  'Reconciliação:',
  JSON.stringify(await request(`/wallets/${wallet.id}/reconciliation`, {}), null, 2),
);
if (
  results.filter((r) => r.status === 'PROCESSED').length !== 1 ||
  results.filter((r) => r.status === 'REJECTED').length !== 1
)
  throw new Error('Unexpected concurrent outcome');

export {};
