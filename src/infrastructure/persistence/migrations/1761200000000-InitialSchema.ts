import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1761200000000 implements MigrationInterface {
  name = 'InitialSchema1761200000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q.query(`CREATE TABLE wallets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid NOT NULL,
      balance numeric(20,2) NOT NULL DEFAULT 0 CHECK (balance >= 0), currency char(3) NOT NULL,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(player_id, currency), UNIQUE(id, player_id, currency)
    )`);
    await q.query(`CREATE TABLE wager_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id text NOT NULL, external_transaction_id text NOT NULL,
      idempotency_key text NOT NULL, payload_hash char(64) NOT NULL, player_id uuid NOT NULL,
      wallet_id uuid NOT NULL REFERENCES wallets(id), round_id text NOT NULL, game_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('BET','WIN','LOSS','REFUND','ROLLBACK','OPENING')),
      amount numeric(20,2) NOT NULL CHECK (amount > 0), currency char(3) NOT NULL,
      reference_external_transaction_id text, status text NOT NULL CHECK (status IN ('PROCESSING','PROCESSED','REJECTED','PENDING_REFERENCE')),
      failure_code text, observed_balance numeric(20,2), attempts integer NOT NULL DEFAULT 0,
      replay_count bigint NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
      next_attempt_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
      UNIQUE(provider_id, external_transaction_id), UNIQUE(provider_id, idempotency_key),
      FOREIGN KEY(wallet_id, player_id, currency) REFERENCES wallets(id, player_id, currency)
    )`);
    await q.query(`CREATE INDEX wager_reference_idx ON wager_transactions(provider_id, external_transaction_id)`);
    await q.query(`CREATE TABLE wallet_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wallet_id uuid NOT NULL REFERENCES wallets(id),
      transaction_id uuid NOT NULL UNIQUE REFERENCES wager_transactions(id), direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
      amount numeric(20,2) NOT NULL CHECK(amount > 0), currency char(3) NOT NULL,
      balance_before numeric(20,2) NOT NULL CHECK(balance_before >= 0), balance_after numeric(20,2) NOT NULL CHECK(balance_after >= 0),
      created_at timestamptz NOT NULL DEFAULT now(), CHECK(balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
    )`);
    await q.query(`CREATE INDEX wallet_ledger_cursor_idx ON wallet_ledger(wallet_id, created_at DESC, id DESC)`);
    await q.query(`CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'wallet ledger is immutable'; END $$`);
    await q.query(`CREATE TRIGGER wallet_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation()`);
    await q.query(`CREATE TABLE inbox_messages (
      consumer_name text NOT NULL, message_id text NOT NULL, status text NOT NULL CHECK(status IN ('PROCESSING','PROCESSED')),
      received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, PRIMARY KEY(consumer_name,message_id)
    )`);
    await q.query(`CREATE TABLE outbox_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL UNIQUE, aggregate_id uuid NOT NULL,
      event_type text NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz, published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX outbox_pending_idx ON outbox_messages(next_attempt_at, created_at) WHERE published_at IS NULL`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS outbox_messages, inbox_messages, wallet_ledger, wager_transactions, wallets CASCADE`);
    await q.query(`DROP FUNCTION IF EXISTS prevent_ledger_mutation()`);
  }
}
