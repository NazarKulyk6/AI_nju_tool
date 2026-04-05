import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Listing {
  url:         string;
  title:       string | null;
  price:       string | null;
  info:        string | null;
  description: string | null;
  category:    string | null;
}

// ─── Pool Singleton ───────────────────────────────────────────────────────────

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host:     process.env.DB_HOST     ?? 'localhost',
      port:     parseInt(process.env.DB_PORT ?? '5432', 10),
      database: process.env.DB_NAME     ?? 'scraper',
      user:     process.env.DB_USER     ?? 'postgres',
      password: process.env.DB_PASSWORD ?? '',
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

// ─── Schema Bootstrap ─────────────────────────────────────────────────────────

export async function initDb(): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS listings (
        id          SERIAL PRIMARY KEY,
        url         TEXT UNIQUE,
        title       TEXT,
        price       TEXT,
        info        TEXT,
        description TEXT,
        category    TEXT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      -- Safe migration: add column if it doesn't exist yet
      ALTER TABLE listings ADD COLUMN IF NOT EXISTS category TEXT;
    `);
    console.log('[DB] Table "listings" is ready.');
  } finally {
    client.release();
  }
}

// ─── Insert ───────────────────────────────────────────────────────────────────

export async function saveToDb(data: Listing): Promise<void> {
  const sql = `
    INSERT INTO listings (url, title, price, info, description, category)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (url) DO UPDATE
      SET category = COALESCE(listings.category, EXCLUDED.category);
  `;
  const values = [
    data.url,
    data.title,
    data.price,
    data.info,
    data.description,
    data.category ?? null,
  ];

  try {
    const result = await getPool().query(sql, values);
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[DB] Saved: ${data.url}`);
    } else {
      console.log(`[DB] Skipped (duplicate): ${data.url}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DB] Insert error for ${data.url}: ${message}`);
    throw err;
  }
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[DB] Connection pool closed.');
  }
}
