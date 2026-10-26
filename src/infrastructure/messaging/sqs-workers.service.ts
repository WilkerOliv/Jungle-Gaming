import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { WageringService } from '../../application/wagering/wagering.service';
import { DomainError } from '../../domain/shared/domain-error';

interface QueueWager {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string; externalTransactionId: string; idempotencyKey: string; playerId: string; walletId: string;
    roundId: string; gameId: string; kind: 'BET'|'WIN'|'LOSS'|'REFUND'|'ROLLBACK';
    money: { amount: string; currency: string }; referenceExternalTransactionId?: string;
  };
}

function isQueueWager(value: unknown): value is QueueWager {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Partial<QueueWager>;
  const data = envelope.data;
  if (envelope.type !== 'WagerTransactionRequested' || typeof envelope.messageId !== 'string' || !envelope.messageId.trim() || envelope.messageId.length > 200 ||
      typeof envelope.occurredAt !== 'string' || Number.isNaN(Date.parse(envelope.occurredAt)) || typeof data !== 'object' || data === null) return false;
  const wager = data as Partial<QueueWager['data']>;
  const stringFields = [wager.providerId,wager.externalTransactionId,wager.idempotencyKey,wager.playerId,wager.walletId,wager.roundId,wager.gameId];
  if (stringFields.some((field) => typeof field !== 'string' || !field.trim()) ||
      typeof wager.providerId !== 'string' || wager.providerId.length > 100 ||
      typeof wager.externalTransactionId !== 'string' || wager.externalTransactionId.length > 200 ||
      typeof wager.idempotencyKey !== 'string' || wager.idempotencyKey.length > 200 ||
      typeof wager.roundId !== 'string' || wager.roundId.length > 200 ||
      typeof wager.gameId !== 'string' || wager.gameId.length > 200 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(wager.playerId ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(wager.walletId ?? '') ||
      !['BET','WIN','LOSS','REFUND','ROLLBACK'].includes(wager.kind ?? '') || typeof wager.money !== 'object' || wager.money === null ||
      typeof wager.money.amount !== 'string' || !/^(0|[1-9]\d*)\.\d{2}$/.test(wager.money.amount) ||
      typeof wager.money.currency !== 'string' || !/^[a-zA-Z]{3}$/.test(wager.money.currency) ||
      (wager.referenceExternalTransactionId !== undefined && (typeof wager.referenceExternalTransactionId !== 'string' || wager.referenceExternalTransactionId.length > 200))) return false;
  return true;
}

@Injectable()
export class SqsWorkersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsWorkersService.name);
  private readonly sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.SQS_ENDPOINT, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
  private stopping = false;
  private consumerLoop?: Promise<void>;
  private outboxLoop?: Promise<void>;
  private referenceLoop?: Promise<void>;
  private readonly queueUrl = process.env.SQS_QUEUE_URL ?? '';
  private readonly dlqUrl = process.env.SQS_DLQ_URL ?? '';
  private readonly eventsQueueUrl = process.env.SQS_EVENTS_QUEUE_URL ?? '';

  constructor(private readonly db: DataSource, private readonly wagering: WageringService) {}

  onModuleInit(): void {
    if (!this.queueUrl || !this.dlqUrl || !this.eventsQueueUrl) { this.logger.warn('SQS workers disabled: queue URLs are not configured.'); return; }
    this.consumerLoop = this.consume();
    this.outboxLoop = this.publishOutbox();
    this.referenceLoop = this.retryReferences();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([this.consumerLoop, this.outboxLoop, this.referenceLoop]);
    await this.sqs.destroy();
  }

  private async consume(): Promise<void> {
    while (!this.stopping) {
      try {
        const batch = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 5, WaitTimeSeconds: 10, VisibilityTimeout: 60, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
        for (const message of batch.Messages ?? []) {
          if (this.stopping) {
            if (message.ReceiptHandle) await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }));
            continue;
          }
          if (!message.Body || !message.ReceiptHandle) continue;
          try {
            const parsed: unknown = JSON.parse(message.Body);
            if (!isQueueWager(parsed)) throw new Error('INVALID_QUEUE_MESSAGE');
            const envelope = parsed;
            const result = await this.wagering.submit(envelope.data, { consumerName: 'wager-transaction-v1', messageId: envelope.messageId });
            await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
          } catch (error) {
            const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
            const postgresCode = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
            const permanent = error instanceof SyntaxError || (error instanceof Error && error.message === 'INVALID_QUEUE_MESSAGE') ||
              error instanceof DomainError || error instanceof HttpException || ['22P02','23503','23505','23514'].includes(postgresCode);
            if (permanent || count >= 5) {
              await this.sqs.send(new SendMessageCommand({ QueueUrl: this.dlqUrl, MessageBody: message.Body, MessageGroupId: 'invalid-or-exhausted', MessageDeduplicationId: `${message.MessageId ?? Date.now()}-${count}` }));
              await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
              this.logger.error(JSON.stringify({ event: 'sqs_message_dlq', messageId: message.MessageId, receiveCount: count }));
            } else {
              await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: Math.min(300, 2 ** count) }));
              this.logger.warn(JSON.stringify({ event: 'sqs_message_retry', messageId: message.MessageId, receiveCount: count }));
            }
          }
        }
      } catch (error) {
        if (!this.stopping) { this.logger.error(JSON.stringify({ event: 'sqs_receive_failed', reason: error instanceof Error ? error.message : 'unknown' })); await this.delay(1500); }
      }
    }
  }

  private async publishOutbox(): Promise<void> {
    while (!this.stopping) {
      try {
        const claimed = await this.db.transaction(async (manager) => {
          const rows = await manager.query(`SELECT id,event_id,aggregate_id,payload FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at<=now() AND (locked_until IS NULL OR locked_until<now()) ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED`);
          for (const row of rows) await manager.query(`UPDATE outbox_messages SET locked_until=now()+interval '60 seconds' WHERE id=$1`, [row.id]);
          return rows;
        });
        if (!claimed.length) { await this.delay(1000); continue; }
        for (const row of claimed) {
          try {
            await this.sqs.send(new SendMessageCommand({ QueueUrl: this.eventsQueueUrl, MessageBody: typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload), MessageGroupId: String(row.aggregate_id), MessageDeduplicationId: String(row.event_id) }));
            await this.db.query(`UPDATE outbox_messages SET published_at=now(),locked_until=NULL WHERE id=$1 AND published_at IS NULL`, [row.id]);
          } catch (error) {
            await this.db.query(`UPDATE outbox_messages SET attempts=attempts+1,next_attempt_at=now()+LEAST(interval '300 seconds',interval '1 second'*power(2,LEAST(attempts+1,8))),locked_until=NULL WHERE id=$1`, [row.id]);
            this.logger.warn(JSON.stringify({ event: 'outbox_publish_retry', eventId: row.event_id, reason: error instanceof Error ? error.message : 'unknown' }));
          }
        }
      } catch (error) {
        if (!this.stopping) { this.logger.error(JSON.stringify({ event: 'outbox_poll_failed', reason: error instanceof Error ? error.message : 'unknown' })); await this.delay(1500); }
      }
    }
  }
  private async retryReferences(): Promise<void> {
    while (!this.stopping) {
      try { await this.wagering.retryPendingReferences(); }
      catch (error) { if (!this.stopping) this.logger.error(JSON.stringify({ event: 'pending_reference_retry_failed', reason: error instanceof Error ? error.message : 'unknown' })); }
      await this.delay(1000);
    }
  }
  private delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
}
