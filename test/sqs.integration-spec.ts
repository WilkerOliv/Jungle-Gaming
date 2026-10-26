import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { WageringService } from '../src/application/wagering/wagering.service';
import { SqsWorkersService } from '../src/infrastructure/messaging/sqs-workers.service';
import { InitialSchema1761200000000 } from '../src/infrastructure/persistence/migrations/1761200000000-InitialSchema';
import { FinancialIntegrity1761200001000 } from '../src/infrastructure/persistence/migrations/1761200001000-FinancialIntegrity';
import { ReconciliationAndReversalConstraints1761200002000 } from '../src/infrastructure/persistence/migrations/1761200002000-ReconciliationAndReversalConstraints';
import { FailedTransactionStatus1761200003000 } from '../src/infrastructure/persistence/migrations/1761200003000-FailedTransactionStatus';
import { AppRolePermissions1761200004000 } from '../src/infrastructure/persistence/migrations/1761200004000-AppRolePermissions';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.SQS_ENDPOINT);
const integration = enabled ? describe : describe.skip;

integration('LocalStack SQS, Inbox, Outbox, and DLQ recovery', () => {
  jest.setTimeout(60_000);
  let db: DataSource;
  let peer: DataSource;
  let migrationDb: DataSource;
  let wagering: WageringService;
  let workerA: SqsWorkersService;
  let workerB: SqsWorkersService;
  const endpoint = process.env.SQS_ENDPOINT!;
  const client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1', endpoint,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
  });
  const suffix = randomUUID().replaceAll('-', '');
  const names = {
    queue: `wager-it-${suffix}.fifo`, dlq: `wager-it-dlq-${suffix}.fifo`, events: `wager-it-events-${suffix}.fifo`,
  };
  const url = (name: string) => `${endpoint}/000000000000/${name}`;
  let createdQueues: string[] = [];

  beforeAll(async () => {
    migrationDb = new DataSource({ type: 'postgres', url: process.env.TEST_MIGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL, migrations: [
      InitialSchema1761200000000, FinancialIntegrity1761200001000,
      ReconciliationAndReversalConstraints1761200002000, FailedTransactionStatus1761200003000, AppRolePermissions1761200004000,
    ], synchronize: false });
    db = new DataSource({ type: 'postgres', url: process.env.TEST_DATABASE_URL });
    peer = new DataSource({ type: 'postgres', url: process.env.TEST_DATABASE_URL });
    await Promise.all([migrationDb.initialize(), db.initialize(), peer.initialize()]);
    await migrationDb.runMigrations();
    await migrationDb.query(`TRUNCATE outbox_messages`);
    wagering = new WageringService(db);

    const deadLetter = await client.send(new CreateQueueCommand({ QueueName: names.dlq, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
    const deadLetterUrl = url(names.dlq);
    createdQueues.push(deadLetterUrl);
    const arn = await client.send(new GetQueueAttributesCommand({ QueueUrl: deadLetterUrl, AttributeNames: ['QueueArn'] }));
    const queue = await client.send(new CreateQueueCommand({ QueueName: names.queue, Attributes: {
      FifoQueue: 'true', ContentBasedDeduplication: 'false',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn.Attributes?.QueueArn, maxReceiveCount: '5' }),
    } }));
    const events = await client.send(new CreateQueueCommand({ QueueName: names.events, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
    createdQueues.push(url(names.queue), url(names.events));

    process.env.SQS_QUEUE_URL = url(names.queue);
    process.env.SQS_DLQ_URL = url(names.dlq);
    process.env.SQS_EVENTS_QUEUE_URL = url(names.events);
    workerA = new SqsWorkersService(db, wagering);
    workerB = new SqsWorkersService(peer, new WageringService(peer));
    workerA.onModuleInit();
    workerB.onModuleInit();
  });

  afterAll(async () => {
    await Promise.allSettled([workerA?.onModuleDestroy(), workerB?.onModuleDestroy()]);
    await Promise.all(createdQueues.map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))));
    if (db?.isInitialized) await db.destroy();
    if (peer?.isInitialized) await peer.destroy();
    if (migrationDb?.isInitialized) await migrationDb.destroy();
    client.destroy();
  });

  async function eventually(assertion: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await assertion()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for the SQS worker condition.');
  }

  it('recovers a committed transaction after redelivery, publishes the outbox, and routes invalid input to DLQ', async () => {
    const playerId = randomUUID();
    const wallet = await wagering.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const messageId = `crash-after-commit-${randomUUID()}`;
    const wager = {
      providerId: 'sqs-integration', externalTransactionId: `external-${randomUUID()}`, idempotencyKey: `idempotency-${randomUUID()}`,
      playerId, walletId: wallet.id, roundId: 'sqs-round', gameId: 'sqs-game', kind: 'BET' as const,
      money: { amount: '40.00', currency: 'BRL' },
    };
    // Models a process dying after its database commit but before deleting the SQS message.
    const committed = await wagering.submit(wager, { consumerName: 'wager-transaction-v1', messageId });
    const envelope = { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: wager };
    await client.send(new SendMessageCommand({ QueueUrl: url(names.queue), MessageBody: JSON.stringify(envelope), MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID() }));

    await eventually(async () => {
      const rows = await db.query(`SELECT count(*)::int AS count FROM wallet_ledger WHERE wallet_id=$1 AND direction='DEBIT'`, [wallet.id]);
      return rows[0].count === 1;
    });
    await eventually(async () => {
      const rows = await db.query(`SELECT count(*)::int AS count FROM outbox_messages WHERE aggregate_id IN ($1,$2) AND published_at IS NOT NULL`, [committed.transactionId,wallet.id]);
      return rows[0].count === 2;
    });
    const outboxRows = await db.query(`SELECT event_id FROM outbox_messages WHERE aggregate_id IN ($1,$2)`, [committed.transactionId,wallet.id]);
    const unpublishedEvents = new Set<string>(outboxRows.map((row: { event_id: string }) => row.event_id));
    await eventually(async () => {
      const messages = await client.send(new ReceiveMessageCommand({ QueueUrl: url(names.events), MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      for (const message of messages.Messages ?? []) {
        if (message.Body) {
          try { unpublishedEvents.delete(JSON.parse(message.Body).eventId); } catch {}
        }
        if (message.ReceiptHandle) await client.send(new DeleteMessageCommand({ QueueUrl: url(names.events), ReceiptHandle: message.ReceiptHandle }));
      }
      return unpublishedEvents.size === 0;
    });
    expect((await wagering.reconcile(wallet.id)).storedBalance.amount).toBe('60.00');

    const invalidMessages = [
      '{not-json',
      JSON.stringify({ ...envelope, messageId: `forbidden-opening-${randomUUID()}`, data: { ...wager, kind: 'OPENING' } }),
    ];
    for (const body of invalidMessages) {
      await client.send(new SendMessageCommand({ QueueUrl: url(names.queue), MessageBody: body, MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID() }));
      let dlqMessage: { MessageId?: string; ReceiptHandle?: string } | undefined;
      await eventually(async () => {
        const messages = await client.send(new ReceiveMessageCommand({ QueueUrl: url(names.dlq), MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }));
        dlqMessage = messages.Messages?.[0];
        return Boolean(dlqMessage);
      });
      expect(dlqMessage?.MessageId).toBeTruthy();
      if (dlqMessage?.ReceiptHandle) await client.send(new DeleteMessageCommand({ QueueUrl: url(names.dlq), ReceiptHandle: dlqMessage.ReceiptHandle }));
    }
  });
});
