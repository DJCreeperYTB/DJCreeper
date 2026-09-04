-- À exécuter une seule fois sur une base déjà initialisée avec l’ancien schema.sql.
ALTER TABLE orders ADD COLUMN order_status TEXT NOT NULL DEFAULT 'EN PRÉPARATION';
