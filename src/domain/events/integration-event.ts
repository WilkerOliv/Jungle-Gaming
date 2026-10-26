import { randomUUID } from 'node:crypto';
import { MoneyProps } from '../money/money';

export interface EventContext { correlationId: string; causationId?: string; occurredAt?: Date; }
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  readonly version = 1;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  protected constructor(aggregateId: string, readonly data: Readonly<T>, context: EventContext) {
    this.eventId = randomUUID(); this.aggregateId = aggregateId; this.correlationId = context.correlationId;
    this.causationId = context.causationId; this.occurredAt = context.occurredAt ?? new Date();
  }
  toJSON() { return { eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId, correlationId: this.correlationId, ...(this.causationId ? { causationId: this.causationId } : {}), occurredAt: this.occurredAt.toISOString(), version: this.version, data: this.data }; }
}

export interface WagerEventData { transactionId: string; walletId: string; providerId: string; status: string; failureCode?: string | null; }
export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed'; constructor(id: string, data: WagerEventData, ctx: EventContext) { super(id,data,ctx); }
}
export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionRejected'; constructor(id: string, data: WagerEventData, ctx: EventContext) { super(id,data,ctx); }
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionPendingReference'; constructor(id: string, data: WagerEventData, ctx: EventContext) { super(id,data,ctx); }
}
export interface WalletBalanceChangedData { walletId: string; transactionId: string; direction: 'DEBIT'|'CREDIT'; money: MoneyProps; balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion?: number; }
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged'; constructor(id: string, data: WalletBalanceChangedData, ctx: EventContext) { super(id,data,ctx); }
}
