import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { WageringService } from '../../application/wagering/wagering.service';

class MoneyDto {
  @IsString() @Matches(/^(0|[1-9]\d*)\.\d{2}$/) amount!: string;
  @IsString() @Length(3,3) currency!: string;
}
class CreateWalletDto {
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) playerId!: string;
  @ValidateNested() @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
class SubmitWagerDto {
  @IsString() @MaxLength(100) providerId!: string;
  @IsString() @MaxLength(200) externalTransactionId!: string;
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) playerId!: string;
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) walletId!: string;
  @IsString() @MaxLength(200) roundId!: string;
  @IsString() @MaxLength(200) gameId!: string;
  @IsIn(['BET','WIN','LOSS','REFUND','ROLLBACK']) kind!: 'BET'|'WIN'|'LOSS'|'REFUND'|'ROLLBACK';
  @ValidateNested() @Type(() => MoneyDto) money!: MoneyDto;
  @IsOptional() @IsString() referenceExternalTransactionId?: string;
}

@Controller()
export class WageringController {
  constructor(private readonly service: WageringService) {}
  @Post('wallets') createWallet(@Body() body: CreateWalletDto) { return this.service.createWallet(body.playerId, body.initialBalance); }
  @Get('wallets/:walletId') getWallet(@Param('walletId') id: string) { return this.service.getWallet(id); }
  @Get('wallets/:walletId/ledger') getLedger(@Param('walletId') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) { return this.service.ledger(id, Number(limit ?? '50'), cursor); }
  @Post('wagering/transactions') @HttpCode(200) async submit(@Body() body: SubmitWagerDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) response: { statusCode: number }) {
    if (!key?.trim()) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    if (key.trim().length > 200) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_TOO_LONG' });
    const result = await this.service.submit({ ...body, idempotencyKey: key });
    response.statusCode = result.status === 'PENDING_REFERENCE' ? 202 : result.status === 'REJECTED' ? 422 : 200;
    return result;
  }
  @Get('wagering/transactions/:transactionId') getTransaction(@Param('transactionId') id: string) { return this.service.getTransaction(id); }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId') getExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) { return this.service.getExternal(providerId, externalId); }
  @Post('wallets/:walletId/reconciliation') reconcile(@Param('walletId') id: string) { return this.service.reconcile(id); }
}
