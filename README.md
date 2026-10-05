# Jungle — Distributed Wagering Processor

Implementação do [desafio backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge), com Bun 1.x, NestJS, TypeScript estrito, MikroORM, PostgreSQL e SQS via LocalStack.

## Baixar o projeto

Instale o [Git](https://git-scm.com/downloads) e o [Docker com Docker Compose](https://docs.docker.com/get-started/get-docker/). Inicie o Docker antes de executar os comandos abaixo. Para executar tudo com Docker, não é necessário instalar Bun, Node.js ou PostgreSQL na sua máquina.

No terminal, baixe o repositório e entre na pasta:

```bash
git clone https://github.com/joaocastro0429/teste_jungle.git
cd teste_jungle
```

Se preferir baixar sem Git, abra o [repositório no GitHub](https://github.com/joaocastro0429/teste_jungle), clique em **Code → Download ZIP**, extraia o arquivo e abra um terminal dentro da pasta extraída.

## Instalar e executar com Docker

Requer Docker com Compose. Na raiz:

```bash
docker compose up --build -d
curl http://localhost:3000/health/ready
```

O serviço `migrate` aplica a migration antes de iniciar a API e o worker. A API fica em `http://localhost:3000`; PostgreSQL em `localhost:55432`; LocalStack em `localhost:4566`. As filas são criadas automaticamente. Aguarde o health retornar `ready`.

O primeiro comando instala as dependências na imagem e inicia os serviços. A primeira execução pode demorar enquanto as imagens são baixadas. As portas `3000`, `55432` e `4566` precisam estar livres. Se o health ainda não responder, repita a consulta após alguns segundos. A resposta esperada é `{"status":"ready"}`.

Para verificar a aplicação na prática:

```bash
docker compose exec api bun run demo
docker compose exec api bun scripts/test-api.ts
```

A demo e o teste da API criam carteiras novas e verificam operações financeiras; esses dados ficam disponíveis para consulta no banco local.

```bash
docker compose logs -f api worker
docker compose up -d --scale worker=3
docker compose down
```

`down` preserva o volume do banco. Não execute `down -v` se quiser preservar seus dados.

## Desenvolvimento e testes

Requer Bun 1.x. Caso precise instalar: `curl -fsSL https://bun.sh/install | bash`. Abra outro terminal depois da instalação.

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres localstack
bun run migrate
bun run dev
# em outro terminal:
bun run worker
```

Bun lê `.env` automaticamente. Os testes usam um banco descartável e filas exclusivas, isolados da aplicação:

```bash
bun run typecheck
bun run test
bun run test:integration
# ou todos:
bun run test:all
```

Os testes criam um banco temporário e filas com prefixo exclusivo e os removem ao concluir; o usuário de desenvolvimento precisa de permissão CREATE DATABASE. O teste de crash mata um processo filho por SIGKILL e aguarda 31 segundos pela visibilidade da mensagem. A suíte cobre PostgreSQL e SQS reais, 50 duplicatas paralelas, duas apostas de 80 contra saldo 100, três processos independentes, reversões, inbox, publishers concorrentes, DLQ e reconciliação.

Migrations versionadas em `migrations/`. `bun run migrate:down` desfaz a migration e **remove as tabelas da aplicação e seus dados**; use apenas num banco descartável. O runner serializa migrations com advisory lock específico; processamento financeiro não usa lock global.

## Demonstração

Com a API rodando:

```bash
bun run demo
# sem Bun local:
docker compose exec api bun run demo
```

A demonstração cria saldo `100.00`, dispara duas apostas concorrentes de `80.00`, verifica uma aplicação e uma rejeição, repete uma requisição e mostra reconciliação com saldo `20.00`.

## API

Valores monetários são strings com exatamente duas casas. Moedas suportadas nos contratos: BRL, USD e EUR; operações devem usar a moeda da wallet. Cada operação, exceto LOSS, exige valor positivo. LOSS exige `0.00`.

```bash
curl -s http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Copie o `id` retornado para `walletId`:

```bash
curl -s http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"SUBSTITUA-PELO-ID","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

| Método | Caminho                                                               | Uso                                      |
| ------ | --------------------------------------------------------------------- | ---------------------------------------- |
| POST   | `/wallets`                                                            | Abrir wallet e registrar crédito OPENING |
| GET    | `/wallets/:walletId`                                                  | Saldo atual                              |
| GET    | `/wallets/:walletId/ledger?limit=50&cursor=...`                       | Ledger paginado, ordem estável           |
| POST   | `/wagering/transactions`                                              | BET, WIN, LOSS, REFUND, ROLLBACK         |
| GET    | `/wagering/transactions/:transactionId`                               | Resultado persistido                     |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo ID externo                 |
| POST   | `/wallets/:walletId/reconciliation`                                   | Conferir saldo contra ledger             |
| GET    | `/health/live`                                                        | Processo vivo                            |
| GET    | `/health/ready`                                                       | Banco e filas disponíveis                |
| GET    | `/metrics`                                                            | Métricas Prometheus da API               |

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. `X-Correlation-Id` é opcional. O header `Idempotency-Key` é obrigatório e precisa ser reutilizado em retries; não gere uma nova chave para a mesma operação.

| HTTP | Significado                                                          |
| ---- | -------------------------------------------------------------------- |
| 200  | Processada ou replay da processada                                   |
| 201  | Wallet criada                                                        |
| 202  | Aguardando referência                                                |
| 400  | Payload inválido                                                     |
| 404  | Wallet/transação não encontrada                                      |
| 409  | Wallet duplicada, conflito de chave ou identidade                    |
| 422  | Rejeição financeira, auditada e terminal                             |
| 503  | Infraestrutura temporariamente indisponível; repetir com mesma chave |

Consultas retornam 200 com o estado persistido, inclusive estados rejeitados. Reconciliação retorna 200 com `consistent` na resposta.

## Mensagens SQS

Filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`. O envelope de entrada:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-02T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-1",
    "idempotencyKey": "provider-a:bet-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "SUBSTITUA-PELO-ID",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Use `MessageGroupId=walletId`; `MessageDeduplicationId` não substitui a idempotência do banco. IDs de envelope devem ser únicos e estáveis em redelivery. Eventos de saída têm `eventId`, `eventType`, `version`, `aggregateId`, `correlationId`, `occurredAt` e `data`.

## Onde estudar o código

1. `src/domain/money.ts`: cálculo exato em centavos usando bigint.
2. `src/domain/transaction.ts`: validações e transições explícitas.
3. `src/application/wagering.ts`: caso de uso comum à API e à fila.
4. `migrations/001_initial.up.sql`: constraints e triggers.
5. `src/infrastructure/workers.ts`: ack, retry, DLQ e publicação após commit.
6. `tests/integration/system.test.ts`: demonstrações executáveis das garantias.

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para decisões, códigos de falha e limitações. Autenticação foi deixada como extensão documentada, conforme permitido no desafio.

Cada worker expõe health e métricas na porta interna 3001. Exemplo: `docker compose exec worker bun -e 'console.log(await (await fetch("http://localhost:3001/metrics")).text())'`.
