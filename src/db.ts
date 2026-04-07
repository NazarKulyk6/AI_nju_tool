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

// ─── Pending URLs table ───────────────────────────────────────────────────────
//
// Stores listing URLs collected during Stage 1 so they are never held
// in process memory.  Each scrape job gets its own job_id bucket.
//
export interface PendingUrlRow {
  url: string;
}

// ─── Schema Bootstrap ─────────────────────────────────────────────────────────
//
// Uniqueness rule:
//   A listing is considered a duplicate only if the same URL was already
//   saved with the SAME category (NULL treated as empty string).
//   The same URL with a different category IS a separate row.
//
// Migration path (safe for existing installations):
//   1. Create table if not exists (no UNIQUE on url — that was the old schema)
//   2. Add category column if missing (old installations had it via ALTER TABLE)
//   3. Drop the old single-column unique constraint on url if still present
//   4. Create the new composite expression index (url, COALESCE(category,''))
//
export async function initDb(): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    // Step 1 — create table (without url UNIQUE — handled by index below)
    await client.query(`
      CREATE TABLE IF NOT EXISTS listings (
        id          SERIAL PRIMARY KEY,
        url         TEXT NOT NULL,
        title       TEXT,
        price       TEXT,
        info        TEXT,
        description TEXT,
        category    TEXT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Step 2 — add category column to pre-existing tables
    await client.query(`
      ALTER TABLE listings ADD COLUMN IF NOT EXISTS category TEXT;
    `);

    // Step 3 — drop old single-column unique constraint on url (if present)
    await client.query(`
      ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_url_key;
    `);

    // Step 4 — composite unique index: same URL + same category = duplicate
    //           COALESCE normalises NULL → '' so (url, NULL) is also unique
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS listings_url_cat_uq
        ON listings (url, COALESCE(category, ''));
    `);

    // Step 5 — pending_urls: temporary URL queue for scrape jobs
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_urls (
        id         SERIAL PRIMARY KEY,
        job_id     TEXT        NOT NULL,
        url        TEXT        NOT NULL,
        processed  BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS pending_urls_job_idx ON pending_urls (job_id);
      CREATE UNIQUE INDEX IF NOT EXISTS pending_urls_job_url_uq ON pending_urls (job_id, url);
    `);

    // Step 6 — add "processed" flag to listings (used by the AI analyzer)
    await client.query(`
      ALTER TABLE listings ADD COLUMN IF NOT EXISTS processed BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // Step 7 — analyzed_items: structured output produced by the AI analyzer
    await client.query(`
      CREATE TABLE IF NOT EXISTS analyzed_items (
        id           SERIAL  PRIMARY KEY,
        listing_id   INTEGER REFERENCES listings(id) ON DELETE CASCADE,
        category     TEXT,
        subcategory  TEXT,
        type         TEXT,
        title        TEXT,
        price        NUMERIC,
        capacity_gb  INTEGER,
        ram_gb       INTEGER,
        cpu          TEXT,
        storage_gb   INTEGER,
        raw          JSONB,
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS analyzed_items_listing_idx ON analyzed_items (listing_id);
    `);

    console.log('[DB] Tables "listings", "pending_urls", and "analyzed_items" ready.');
  } finally {
    client.release();
  }
}

// ─── Insert ───────────────────────────────────────────────────────────────────
//
// Saves a listing.  Skips silently if the same (url, category) pair already
// exists.  A listing with the same URL but a different category IS saved as a
// new row so the same item can appear in multiple categories.
//
export async function saveToDb(data: Listing): Promise<void> {
  // Use WHERE NOT EXISTS instead of ON CONFLICT because PostgreSQL does not
  // allow expressions in the ON CONFLICT inference target.
  const sql = `
    INSERT INTO listings (url, title, price, info, description, category)
    SELECT $1, $2, $3, $4, $5, $6
    WHERE NOT EXISTS (
      SELECT 1 FROM listings
      WHERE url = $1
        AND COALESCE(category, '') = COALESCE($6::TEXT, '')
    );
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
      console.log(`[DB] Saved: ${data.url} [${data.category ?? 'no category'}]`);
    } else {
      console.log(`[DB] Skipped (already in category "${data.category ?? ''}"): ${data.url}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DB] Insert error for ${data.url}: ${message}`);
    throw err;
  }
}

// ─── Pre-filter: check which URLs are already saved for a given category ──────
//
// Returns the subset of `urls` that are already present in the DB for
// `category`.  Used in Stage 1 so we can skip re-parsing known listings.
//
export async function getExistingUrls(
  urls: string[],
  category: string | null | undefined,
): Promise<Set<string>> {
  if (urls.length === 0) return new Set<string>();

  const result = await getPool().query<{ url: string }>(
    `SELECT url
       FROM listings
      WHERE url = ANY($1)
        AND COALESCE(category, '') = COALESCE($2::TEXT, '')`,
    [urls, category ?? null],
  );

  return new Set(result.rows.map((r) => r.url));
}

// ─── Pending URL queue ────────────────────────────────────────────────────────

/**
 * Queue a single URL for processing in Stage 2.
 * Ignores duplicates (same job_id + url) silently.
 */
export async function enqueuePendingUrl(jobId: string, url: string): Promise<void> {
  await getPool().query(
    `INSERT INTO pending_urls (job_id, url)
     VALUES ($1, $2)
     ON CONFLICT (job_id, url) DO NOTHING;`,
    [jobId, url],
  );
}

/**
 * Count all pending (unprocessed) URLs for a job.
 */
export async function countPendingUrls(jobId: string): Promise<number> {
  const r = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM pending_urls WHERE job_id = $1 AND NOT processed`,
    [jobId],
  );
  return parseInt(r.rows[0].count, 10);
}

/**
 * Fetch all URLs for a job that are NOT yet saved in `listings` for the given
 * category.  Filtering is done in the DB so no large arrays are held in memory.
 */
export async function fetchPendingUrls(
  jobId: string,
  category: string | null | undefined,
): Promise<string[]> {
  const r = await getPool().query<{ url: string }>(
    `SELECT p.url
       FROM pending_urls p
      WHERE p.job_id = $1
        AND NOT p.processed
        AND NOT EXISTS (
          SELECT 1 FROM listings l
           WHERE l.url = p.url
             AND COALESCE(l.category, '') = COALESCE($2::TEXT, '')
        )
      ORDER BY p.id`,
    [jobId, category ?? null],
  );
  return r.rows.map((row) => row.url);
}

/**
 * Count how many URLs were queued but already exist in `listings` for the
 * given category (i.e. they will be skipped).
 */
export async function countSkippedUrls(
  jobId: string,
  category: string | null | undefined,
): Promise<number> {
  const r = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM pending_urls p
      WHERE p.job_id = $1
        AND EXISTS (
          SELECT 1 FROM listings l
           WHERE l.url = p.url
             AND COALESCE(l.category, '') = COALESCE($2::TEXT, '')
        )`,
    [jobId, category ?? null],
  );
  return parseInt(r.rows[0].count, 10);
}

/**
 * Mark a URL as processed (called after successful parse + save).
 */
export async function markUrlProcessed(jobId: string, url: string): Promise<void> {
  await getPool().query(
    `UPDATE pending_urls SET processed = TRUE WHERE job_id = $1 AND url = $2`,
    [jobId, url],
  );
}

/**
 * Delete all pending URL rows for a completed job.
 */
export async function cleanupPendingUrls(jobId: string): Promise<void> {
  const r = await getPool().query(
    `DELETE FROM pending_urls WHERE job_id = $1`,
    [jobId],
  );
  console.log(`[DB] Cleaned up ${r.rowCount} pending_urls rows for job ${jobId}.`);
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[DB] Connection pool closed.');
  }
}
