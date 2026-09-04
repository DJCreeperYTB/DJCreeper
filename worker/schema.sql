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
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_access ON tickets(ticket_number, access_token_hash);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON tickets(order_id);
