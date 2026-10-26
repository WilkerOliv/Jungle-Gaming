import { randomUUID } from 'node:crypto';
import { DomainError } from '../shared/domain-error';
import { Money, MoneyProps } from '../money/money';

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'OPENING';
export type WagerStatus = 'PROCESSING' | 'PROCESSED' | 'REJECTED' | 'FAILED' | 'PENDING_REFERENCE';
export interface WagerTransactionProps {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string;
  playerId: string; walletId: string; roundId: string; gameId: string;
  kind: WagerKind; money: MoneyProps; referenceExternalTransactionId?: string;
  payloadHash: string; status: WagerStatus; failureCode?: string; observedBalance?: MoneyProps;
}

const kinds: readonly string[] = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK', 'OPENING'];
export class WagerTransaction {
  private constructor(private readonly props: WagerTransactionProps) {}
  static create(input: Omit<WagerTransactionProps, 'id' | 'status'>): WagerTransaction {
    if (!input.providerId || !input.externalTransactionId || !input.idempotencyKey || !input.playerId || !input.walletId || !input.roundId || !input.gameId) {
      throw new DomainError('INVALID_TRANSACTION', 'Required transaction identifiers are missing.');
    }
    if (!kinds.includes(input.kind)) throw new DomainError('INVALID_KIND', 'Unsupported wager transaction kind.');
    if (input.kind === 'OPENING') throw new DomainError('INTERNAL_TRANSACTION', 'OPENING transactions can only be created internally.');
    const money = Money.from(input.money);
    if (!money.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Transaction amount must be positive.');
    if (['REFUND', 'ROLLBACK'].includes(input.kind) && !input.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_REQUIRED', `${input.kind} requires a reference transaction.`);
    }
    return new WagerTransaction({ ...input, id: randomUUID(), status: 'PROCESSING' });
  }
  static rehydrate(props: WagerTransactionProps): WagerTransaction { return new WagerTransaction({ ...props }); }
  get value(): Readonly<WagerTransactionProps> { return this.props; }
  processed(observedBalance: Money): WagerTransaction { return this.with({ status: 'PROCESSED', observedBalance: observedBalance.toJSON(), failureCode: undefined }, ['PROCESSING','PENDING_REFERENCE']); }
  rejected(failureCode: string, observedBalance?: Money): WagerTransaction { return this.with({ status: 'REJECTED', failureCode, observedBalance: observedBalance?.toJSON() }, ['PROCESSING','PENDING_REFERENCE']); }
  pendingReference(): WagerTransaction { return this.with({ status: 'PENDING_REFERENCE', failureCode: 'REFERENCE_NOT_FOUND' }); }
  failed(failureCode: string): WagerTransaction { return this.with({ status: 'FAILED', failureCode }, ['PROCESSING','PENDING_REFERENCE']); }
  private with(patch: Partial<WagerTransactionProps>, allowed: readonly WagerStatus[] = ['PROCESSING']): WagerTransaction {
    if (!allowed.includes(this.props.status)) throw new DomainError('TERMINAL_TRANSACTION', 'A terminal transaction cannot transition.');
    return WagerTransaction.rehydrate({ ...this.props, ...patch });
  }
}
