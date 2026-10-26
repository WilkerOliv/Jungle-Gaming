# Jungle Gaming — Distributed Wagering Processor

Serviço HTTP para processar apostas com precisão monetária, idempotência persistente e transações PostgreSQL. Inclui consumidor SQS, Inbox/Outbox transacionais, DLQ, reprocessamento de referências ausentes e endpoints de reconciliação.

## Início rápido

O PostgreSQL e o LocalStack são iniciados pelo Compose. A primeira inicialização também cria um banco separado para os testes e executa as migrations por um serviço de curta duração.

```sh
docker compose up --build -d
docker compose ps
```

A API fica em `http://localhost:3000`. A fila de mensagens fica no LocalStack em `http://localhost:4566`. O PostgreSQL fica acessível no computador em `localhost:5432`.

### Acesso ao PostgreSQL

As credenciais locais, já configuradas no arquivo `.env`, são:

| Campo | Valor |
| --- | --- |
| Host | `localhost` |
| Porta | `5432` |
| Banco da aplicação | `jungle` |
| Banco de testes | `jungle_test` |
| Usuário da aplicação | `jungle_app` |
| Senha local da aplicação | `jungle_app_local_2026` |

Também é possível conectar com `psql`:

```sh
psql 'postgres://jungle_app:jungle_app_local_2026@localhost:5432/jungle'
```

O usuário da aplicação não é superusuário. A conta administrativa local é `postgres`, com senha `jungle_admin_local_2026`; use-a apenas para manutenção. Essas credenciais são somente para desenvolvimento. Para trocá-las, edite `.env` e recrie o volume PostgreSQL, pois o container só aplica os valores de inicialização na primeira criação do banco.

## Executar a API fora do Docker

```sh
docker compose up -d postgres localstack
bun install
bun run build
set -a; . ./.env; set +a
DATABASE_URL="$MIGRATION_DATABASE_URL" bun run migration:run
bun run start:dev
```

O Compose também pode iniciar a API automaticamente com `docker compose up --build -d`. Um serviço de curta duração aplica migrations com a conta administrativa; a API roda como `jungle_app`, que não pode alterar o schema ou apagar e truncar lançamentos do ledger. `GET /health/live` verifica o processo e `GET /health/ready` verifica PostgreSQL e SQS.

## Comandos

- `bun run build` — compila a aplicação.
- `bun run typecheck` — valida os tipos TypeScript.
- `bun run test` — executa testes unitários.
- `bun run test:integration` — executa testes contra PostgreSQL e LocalStack reais; suba o Compose antes.
- `bun run test:e2e` — valida consumo SQS, redelivery, Outbox concorrente e DLQ.
- `bun run migration:run` / `bun run migration:revert` — aplica ou reverte migrations.

## API inicial

- `POST /wallets` — `{ "playerId": "uuid", "initialBalance": { "amount": "100.00", "currency": "BRL" } }`
- `GET /wallets/:walletId`
- `GET /wallets/:walletId/ledger?limit=50&cursor=...`
- `POST /wagering/transactions` — exige `Idempotency-Key`; recebe `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e referência opcional.
- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- `POST /wallets/:walletId/reconciliation`
- `GET /metrics` — status de operações, duplicatas, retries, atraso da Outbox, locks e DLQ.

Valores monetários devem ser strings com duas casas decimais. A API retorna códigos de falha estáveis. Um reenvio idêntico devolve a resposta armazenada; reutilizar a chave com outro payload produz conflito.

## Garantias e execução dos testes

O schema inclui restrições de saldo não negativo, unicidade por jogador/moeda, idempotência e transação externa, consistência entre wallet e ledger, ledger imutável, Inbox e Outbox. O processamento financeiro bloqueia a wallet com `SELECT ... FOR UPDATE`; a chave de idempotência usa advisory lock no PostgreSQL. Saldo, ledger, Inbox e Outbox são confirmados no mesmo commit. O publisher usa `SKIP LOCKED` e lease; falhas são reenfileiradas com backoff. O consumidor confirma a mensagem somente após o commit.

As migrations são versionadas e reversíveis. Para recriar o ambiente local e apagar os dados persistidos, execute `docker compose down -v` seguido de `docker compose up --build -d`. O `.env` local é ignorado pelo Git; `.env.example` documenta os valores de desenvolvimento.
