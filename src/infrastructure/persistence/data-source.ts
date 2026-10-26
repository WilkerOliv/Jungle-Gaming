import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { InitialSchema1761200000000 } from './migrations/1761200000000-InitialSchema';
import { FinancialIntegrity1761200001000 } from './migrations/1761200001000-FinancialIntegrity';
import { ReconciliationAndReversalConstraints1761200002000 } from './migrations/1761200002000-ReconciliationAndReversalConstraints';
import { FailedTransactionStatus1761200003000 } from './migrations/1761200003000-FailedTransactionStatus';
import { AppRolePermissions1761200004000 } from './migrations/1761200004000-AppRolePermissions';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ?? 'postgres://jungle_app:jungle_app_local_2026@localhost:5432/jungle',
  migrations: [InitialSchema1761200000000, FinancialIntegrity1761200001000, ReconciliationAndReversalConstraints1761200002000, FailedTransactionStatus1761200003000, AppRolePermissions1761200004000],
  synchronize: false,
  logging: false,
});
