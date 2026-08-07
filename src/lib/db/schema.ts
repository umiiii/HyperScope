export const SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS monitored_addresses (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      label TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      account_value TEXT NOT NULL DEFAULT '0',
      withdrawable TEXT NOT NULL DEFAULT '0',
      total_margin_used TEXT NOT NULL DEFAULT '0',
      last_checked_at TIMESTAMPTZ,
      last_changed_at TIMESTAMPTZ,
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS monitored_addresses_due_idx
      ON monitored_addresses (active, next_check_at)
  `,
  `
    CREATE TABLE IF NOT EXISTS positions (
      address_id TEXT NOT NULL REFERENCES monitored_addresses(id) ON DELETE CASCADE,
      coin TEXT NOT NULL,
      size TEXT NOT NULL,
      entry_price TEXT,
      position_value TEXT NOT NULL,
      unrealized_pnl TEXT NOT NULL,
      return_on_equity TEXT NOT NULL,
      liquidation_price TEXT,
      margin_used TEXT NOT NULL,
      leverage_type TEXT NOT NULL,
      leverage_value INTEGER NOT NULL,
      leverage_raw_usd TEXT,
      max_leverage INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (address_id, coin)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS position_changes (
      id TEXT PRIMARY KEY,
      address_id TEXT NOT NULL REFERENCES monitored_addresses(id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL,
      coin TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      before_position JSONB,
      after_position JSONB,
      fingerprint TEXT NOT NULL UNIQUE,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS position_changes_address_time_idx
      ON position_changes (address_id, detected_at DESC)
  `,
  `
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint_hash TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      expiration_time BIGINT,
      user_agent TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_success_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      address_id TEXT REFERENCES monitored_addresses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      target_url TEXT NOT NULL,
      tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx
      ON notification_outbox (status, next_attempt_at, created_at)
  `,
  `
    CREATE TABLE IF NOT EXISTS monitor_worker_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL,
      last_started_at TIMESTAMPTZ,
      last_completed_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
] as const;
