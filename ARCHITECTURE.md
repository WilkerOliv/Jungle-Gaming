# Decisões de arquitetura

## Limites

NestJS expõe HTTP; os tipos de domínio não importam NestJS nem TypeORM. O serviço de aplicação coordena as operações e executa SQL parametrizado pelo `DataSource`, deixando locks e constraints visíveis. TypeORM é usado como driver/transação e migrations, sem sincronização automática de schema.

## Dinheiro e ledger

`Money` mantém unidades mínimas inteiras em `bigint`, recebe contratos como strings decimais e nunca converte valores monetários para `number`. PostgreSQL armazena `numeric(20,2)`. Cada movimento gera um lançamento imutável com saldo anterior/posterior; constraints validam a equação do lançamento, e um trigger rejeita UPDATE/DELETE.

## Concorrência e idempotência

As transações financeiras bloqueiam apenas a linha da carteira alvo (`FOR UPDATE`), permitindo progresso simultâneo em carteiras diferentes. O bloqueio é mantido até o commit e impede saldo negativo por corrida entre instâncias. Um advisory lock transacional por provedor/chave serializa a consulta e gravação idempotente; índices únicos no banco continuam sendo a garantia persistente. O hash SHA-256 cobre o JSON canônico dos campos de negócio, sem header nem metadados de transporte.

`Idempotency-Key` é obrigatório, limitado a 200 caracteres e não faz parte do hash. Uma repetição com o mesmo payload retorna o saldo observado originalmente; uma chave repetida com conteúdo diferente resulta em HTTP 409. Operações processadas ou rejeitadas retornam 200 ou 422; uma referência que aguarda resolução retorna 202. Falhas de dependência retornam 503.

## Atomicidade e eventos

Wallet, transação, ledger, Inbox e registros de Outbox são gravados na mesma transação PostgreSQL. O publisher reclama lotes com `FOR UPDATE SKIP LOCKED`, persiste um lease antes de enviar ao SQS e marca o evento publicado depois. Se cair entre envio e marcação, a publicação pode repetir; o `eventId` estável permite deduplicação no consumidor. A Inbox também guarda hash do payload para impedir que uma reutilização do mesmo ID de mensagem mas com conteúdo diferente seja tratada como replay.

## Referências fora de ordem

Uma referência inexistente fica `PENDING_REFERENCE`, preservando o pedido. Um worker busca esses registros com `SKIP LOCKED`, atualiza tentativas e aplica backoff exponencial limitado a uma hora; após 12 tentativas, rejeita com `REFERENCE_NOT_FOUND_EXPIRED`. Dependências ainda pendentes também aguardam retry e podem expirar com `REFERENCE_NOT_PROCESSED_EXPIRED`.

Códigos de falha estáveis incluem `INSUFFICIENT_FUNDS`, `ROLLBACK_WOULD_OVERDRAW`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `INVALID_REFUND_REFERENCE` e `REFERENCE_ALREADY_REVERSED`. Uma constraint única parcial no PostgreSQL impede que a mesma referência seja reembolsada ou revertida duas vezes.

## Observabilidade

Os logs financeiros são JSON e carregam correlação, transação, carteira, provedor e, quando recebida via SQS, o ID da mensagem; não incluem valores nem payload completo. `/metrics` retorna status das operações, replays, tentativas de referências e Outbox, latência, espera por locks, atraso da Outbox, quantidade de DLQ e divergências de reconciliação. Toda reconciliação é persistida; divergência também gera log de erro, sem alterar saldo ou ledger.

## Acesso e ambiente local

Autenticação externa foi deixada fora do escopo, conforme permitido no desafio. O ponto de extensão é um guard NestJS/porta de identidade de provedor; não há autenticação artesanal. O Compose vincula portas ao loopback local. O PostgreSQL usa a conta `jungle_app` para as permissões de leitura e escrita necessárias à API, sem DDL, DELETE ou TRUNCATE. Um serviço de curta duração aplica migrations como `postgres`; `jungle_test` é separado para integração. As credenciais locais nunca devem ser reutilizadas em ambiente publicado.

## Cursor do ledger

A ordenação usa `(created_at, id)` descendente. A consulta serializa `created_at` como texto vindo do PostgreSQL para preservar a precisão de microssegundos no cursor opaco; converter para `Date` do JavaScript truncaria essa precisão e poderia repetir ou pular linhas entre páginas.
