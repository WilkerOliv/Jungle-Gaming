import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WageringService } from './application/wagering/wagering.service';
import { HealthController } from './interfaces/http/health.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { SqsWorkersService } from './infrastructure/messaging/sqs-workers.service';
import { MetricsController } from './interfaces/http/metrics.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), TypeOrmModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      type: 'postgres' as const, url: config.get<string>('DATABASE_URL','postgres://jungle_app:jungle_app_local_2026@localhost:5432/jungle'),
      autoLoadEntities: false, synchronize: false, logging: false, retryAttempts: 3, retryDelay: 1000,
    }),
  })],
  controllers: [WageringController, HealthController, MetricsController],
  providers: [WageringService, SqsWorkersService],
})
export class AppModule {}
