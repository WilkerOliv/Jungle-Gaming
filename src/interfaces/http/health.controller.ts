import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController {
  private readonly sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.SQS_ENDPOINT, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
  private readonly queueUrl = process.env.SQS_QUEUE_URL ?? '';
  constructor(private readonly db: DataSource) {}
  @Get('live') live() { return { status: 'ok' }; }
  @Get('ready') async ready() {
    const dependencies: { postgres: string; sqs: string } = { postgres: 'ok', sqs: 'ok' };
    try { await this.db.query('SELECT 1'); } catch { dependencies.postgres = 'unavailable'; }
    if (!this.queueUrl) dependencies.sqs = 'not_configured';
    else {
      try { await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] })); }
      catch { dependencies.sqs = 'unavailable'; }
    }
    if (dependencies.postgres !== 'ok' || dependencies.sqs !== 'ok') {
      throw new ServiceUnavailableException({ status: 'unavailable', code: 'DEPENDENCY_UNAVAILABLE', dependencies });
    }
    return { status: 'ok', dependencies };
  }
}
