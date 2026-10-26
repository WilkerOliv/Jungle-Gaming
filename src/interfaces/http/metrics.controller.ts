import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';

@Controller('metrics')
export class MetricsController {
  private readonly sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.SQS_ENDPOINT, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
  private readonly dlqUrl = process.env.SQS_DLQ_URL ?? '';
  constructor(private readonly db: DataSource) {}

  @Get()
  async snapshot() {
    try {
      const [statuses, totals, outbox, locks, dlq, reconciliations] = await Promise.all([
        this.db.query(`SELECT status,count(*)::bigint AS count FROM wager_transactions GROUP BY status`),
        this.db.query(`SELECT COALESCE(sum(replay_count),0)::bigint AS duplicates,
          COALESCE(sum(attempts),0)::bigint AS reference_retries,
          (SELECT COALESCE(sum(attempts),0)::bigint FROM outbox_messages) AS outbox_retries,
          COALESCE(avg(EXTRACT(epoch FROM processed_at-created_at)) FILTER (WHERE processed_at IS NOT NULL),0)::numeric(12,3)::text AS average_latency_seconds
          FROM wager_transactions`),
        this.db.query(`SELECT count(*)::bigint AS pending,COALESCE(EXTRACT(epoch FROM now()-min(created_at)),0)::numeric(12,3)::text AS oldest_pending_seconds FROM outbox_messages WHERE published_at IS NULL`),
        this.db.query(`SELECT count(*)::bigint AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock'`),
        this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] })),
        this.db.query(`SELECT count(*)::bigint AS total, count(*) FILTER(WHERE NOT is_consistent)::bigint AS mismatches FROM reconciliation_audits`),
      ]);
      return {
        transactions: Object.fromEntries(statuses.map((row: { status: string; count: string }) => [row.status, Number(row.count)])),
        idempotentDuplicates: Number(totals[0].duplicates),
        retries: Number(totals[0].reference_retries) + Number(totals[0].outbox_retries),
        retryBreakdown: { references: Number(totals[0].reference_retries), outbox: Number(totals[0].outbox_retries) },
        averageProcessingLatencySeconds: Number(totals[0].average_latency_seconds),
        outbox: { pending: Number(outbox[0].pending), oldestPendingSeconds: Number(outbox[0].oldest_pending_seconds) },
        postgresLockWaiters: Number(locks[0].waiting),
        reconciliations: { total: Number(reconciliations[0].total), mismatches: Number(reconciliations[0].mismatches) },
        dlqMessages: Number(dlq.Attributes?.ApproximateNumberOfMessages ?? 0),
      };
    } catch {
      throw new ServiceUnavailableException({ code: 'METRICS_DEPENDENCY_UNAVAILABLE' });
    }
  }
}
