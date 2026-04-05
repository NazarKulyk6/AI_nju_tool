import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { getPool, initDb } from './db';
import { runScraper } from './scraper';
import { buildSearchUrl } from './utils';

dotenv.config();

const app  = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.use(express.json());

// ─── Static files ─────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// ─── Scrape job state ─────────────────────────────────────────────────────────
interface ScrapeJob {
  status:     'idle' | 'running' | 'done' | 'error';
  query:      string;
  category:   string | null;
  startedAt:  string | null;
  finishedAt: string | null;
  error:      string | null;
  saved:      number;
}

let scrapeJob: ScrapeJob = {
  status:     'idle',
  query:      '',
  category:   null,
  startedAt:  null,
  finishedAt: null,
  error:      null,
  saved:      0,
};

// ─── API: Stats ───────────────────────────────────────────────────────────────
app.get('/api/stats', async (_req: Request, res: Response) => {
  try {
    const result = await getPool().query(`
      SELECT
        COUNT(*)                                        AS total,
        COUNT(price)                                    AS with_price,
        TO_CHAR(MAX(created_at), 'DD.MM.YYYY HH24:MI') AS last_scraped
      FROM listings
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── API: Categories ──────────────────────────────────────────────────────────
app.get('/api/categories', async (_req: Request, res: Response) => {
  try {
    const result = await getPool().query(`
      SELECT category, COUNT(*) AS count
      FROM listings
      WHERE category IS NOT NULL AND category <> ''
      GROUP BY category
      ORDER BY count DESC, category
    `);
    res.json(result.rows);   // [{ category: 'ssd', count: '37' }, ...]
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── API: Trigger scrape ──────────────────────────────────────────────────────
app.post('/api/scrape', async (req: Request, res: Response) => {
  if (scrapeJob.status === 'running') {
    res.status(409).json({ error: 'Scraper already running', job: scrapeJob });
    return;
  }

  const query    = ((req.body?.query    as string) ?? '').trim();
  const category = ((req.body?.category as string) ?? '').trim() || null;

  if (!query) {
    res.status(400).json({ error: 'Query is required' });
    return;
  }

  // Snapshot current DB count so we can calculate how many new rows were saved
  let countBefore = 0;
  try {
    const r = await getPool().query('SELECT COUNT(*) FROM listings');
    countBefore = parseInt(r.rows[0].count, 10);
  } catch { /* ignore */ }

  scrapeJob = {
    status:     'running',
    query,
    category,
    startedAt:  new Date().toISOString(),
    finishedAt: null,
    error:      null,
    saved:      0,
  };

  res.json({ ok: true, job: scrapeJob });

  // Run scraper in background — do NOT await
  runScraper(buildSearchUrl(query), category ?? undefined)
    .then(async () => {
      let saved = 0;
      try {
        const r = await getPool().query('SELECT COUNT(*) FROM listings');
        saved = parseInt(r.rows[0].count, 10) - countBefore;
      } catch { /* ignore */ }
      scrapeJob = { ...scrapeJob, status: 'done', finishedAt: new Date().toISOString(), saved };
      console.log(`[Scrape] Job "${query}" done. New rows: ${saved}`);
    })
    .catch((err: Error) => {
      scrapeJob = { ...scrapeJob, status: 'error', error: err.message, finishedAt: new Date().toISOString() };
      console.error(`[Scrape] Job "${query}" failed:`, err.message);
    });
});

// ─── API: Scrape job status ───────────────────────────────────────────────────
app.get('/api/scrape/status', (_req: Request, res: Response) => {
  res.json(scrapeJob);
});

// ─── API: Search / list ───────────────────────────────────────────────────────
app.get('/api/listings', async (req: Request, res: Response) => {
  const q        = ((req.query.q        as string) ?? '').trim();
  const category = ((req.query.category as string) ?? '').trim();
  const page     = Math.max(1, parseInt((req.query.page  as string) ?? '1',  10));
  const limit    = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? '24', 10)));
  const offset   = (page - 1) * limit;

  try {
    const pool = getPool();

    // Build WHERE clause dynamically
    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length} OR info ILIKE $${params.length})`);
    }
    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const dataParams  = [...params, limit, offset];
    const countParams = [...params];

    const rows = await pool.query(
      `SELECT id, url, title, price, category, created_at,
              LEFT(description, 220) AS description_preview
       FROM listings ${where}
       ORDER BY created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams,
    );

    const count = await pool.query(
      `SELECT COUNT(*) FROM listings ${where}`,
      countParams,
    );

    const total      = parseInt(count.rows[0].count, 10);
    const totalPages = Math.ceil(total / limit);

    res.json({ data: rows.rows, pagination: { page, limit, total, totalPages } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── API: Single listing ──────────────────────────────────────────────────────
app.get('/api/listings/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return; }

  try {
    const result = await getPool().query('SELECT * FROM listings WHERE id = $1', [id]);
    if (!result.rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Page routes ──────────────────────────────────────────────────────────────
app.get('/scraper', (_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, 'scraper.html'));
});

// SPA fallback — all other routes serve the listings page
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  await initDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Web] Server ready → http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[Web] Fatal:', err);
  process.exit(1);
});
