-- Base D1 pour les commandes et tickets DJCreeper.
-- Les preuves binaires sont stockées dans R2 ; D1 ne conserve que leurs métadonnées.
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Compteur atomique des octets réservés dans le bucket R2 de preuves.
-- 500 MiB = 524 288 000 octets. Une écriture Worker réserve d’abord sa taille
-- ici ; si le plafond est atteint, elle est refusée côté serveur.
CREATE TABLE IF NOT EXISTS storage_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  quota_bytes INTEGER NOT NULL DEFAULT 524288000 CHECK (quota_bytes = 524288000)
);

INSERT OR IGNORE INTO storage_usage (id, used_bytes, quota_bytes)
VALUES (1, 0, 524288000);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  user_id TEXT,
  customer_json TEXT NOT NULL,
  items_json TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  relay_json TEXT,
  promo_code TEXT,
  payment_status TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  order_status TEXT NOT NULL DEFAULT 'EN PRÉPARATION',
  loyalty_points_used INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_used >= 0),
  loyalty_eligible_cents INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_eligible_cents >= 0),
  loyalty_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_earned >= 0),
  loyalty_awarded_at TEXT,
  loyalty_refunded_at TEXT,
  proof_key TEXT,
  proof_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  ticket_number TEXT NOT NULL UNIQUE,
  order_id TEXT,
  customer_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  items_json TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  relay_json TEXT,
  payment_status TEXT NOT NULL,
  proof_json TEXT,
  status TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  history_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_id TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

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

CREATE INDEX IF NOT EXISTS idx_tickets_access ON tickets(ticket_number, access_token_hash);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
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
