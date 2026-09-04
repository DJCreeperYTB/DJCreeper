-- Migration additive pour la D1 de production existante.
-- Elle ne supprime ni commandes, ni tickets, ni messages (history_json), ni storage_usage.
ALTER TABLE orders ADD COLUMN user_id TEXT;
ALTER TABLE orders ADD COLUMN loyalty_points_used INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_used >= 0);
ALTER TABLE orders ADD COLUMN loyalty_eligible_cents INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_eligible_cents >= 0);
ALTER TABLE orders ADD COLUMN loyalty_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_earned >= 0);
ALTER TABLE orders ADD COLUMN loyalty_awarded_at TEXT;
ALTER TABLE orders ADD COLUMN loyalty_refunded_at TEXT;

ALTER TABLE tickets ADD COLUMN user_id TEXT;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  loyalty_points INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id TEXT PRIMARY KEY,
  transaction_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  order_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('earned', 'spent', 'refund', 'adjustment')),
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_loyalty_user ON loyalty_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_order ON loyalty_transactions(order_id);

CREATE TRIGGER IF NOT EXISTS trg_loyalty_credit
AFTER INSERT ON loyalty_transactions
WHEN NEW.points != 0
BEGIN
  UPDATE users
  SET loyalty_points = loyalty_points + NEW.points,
      updated_at = NEW.created_at
  WHERE id = NEW.user_id;
END;
