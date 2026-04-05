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
  status:            'idle' | 'running' | 'done' | 'error';
  queries:           string[];       // all queued queries
  currentQuery:      string;         // query being scraped right now
  currentQueryIndex: number;         // 1-based index of current query
  totalQueries:      number;         // total queries in this job
  category:          string | null;
  startedAt:         string | null;
  finishedAt:        string | null;
  error:             string | null;
  saved:             number;
}

let scrapeJob: ScrapeJob = {
  status:            'idle',
  queries:           [],
  currentQuery:      '',
  currentQueryIndex: 0,
  totalQueries:      0,
  category:          null,
  startedAt:         null,
  finishedAt:        null,
  error:             null,
  saved:             0,
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
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── API: Gemini — expand search query into Croatian search terms ──────────────
app.post('/api/suggest-queries', async (req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    return;
  }

  const userInput = ((req.body?.query as string) ?? '').trim();
  if (!userInput) {
    res.status(400).json({ error: 'Query is required.' });
    return;
  }

  const prompt = `You are a search assistant for njuskalo.hr — the largest Croatian classifieds website.
The user wants to find listings for: "${userInput}"

Generate a comprehensive list of search terms that would capture ALL relevant listings on this site.
Rules:
- Include Croatian translations, common local abbreviations, brand names, model variations, alternative spellings
- Use terms that Croatian sellers would actually type when creating listings
- Mix Croatian and English terms (both are common on the site)
- Each term should be 1-5 words
- Return 10-20 terms depending on the complexity of the item
- Return ONLY a valid JSON array of strings — no explanations, no markdown, no extra text

Example for input "rtx 2060":
["rtx 2060","nvidia 2060","grafička kartica 2060","geforce 2060","2060 super","rtx2060","2060 6gb","vga 2060","nvidia rtx 2060","2060 gaming"]`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
        }),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      console.error('[Gemini] API error:', errBody);
      res.status(502).json({ error: `Gemini API error: ${response.status}` });
      return;
    }

    const data = await response.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // Extract JSON array from the response (handle possible markdown code fences)
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      console.error('[Gemini] Could not parse JSON from:', raw);
      res.status(502).json({ error: 'Gemini returned unexpected format.', raw });
      return;
    }

    const terms: string[] = JSON.parse(match[0]);
    // Deduplicate and clean
    const unique = [...new Set(terms.map((t: string) => t.trim().toLowerCase()).filter(Boolean))];

    console.log(`[Gemini] Expanded "${userInput}" → ${unique.length} terms`);
    res.json({ terms: unique });
  } catch (err) {
    console.error('[Gemini] Request failed:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── API: Trigger scrape (supports multiple queries) ──────────────────────────
app.post('/api/scrape', async (req: Request, res: Response) => {
  if (scrapeJob.status === 'running') {
    res.status(409).json({ error: 'Scraper already running', job: scrapeJob });
    return;
  }

  // Accept either a single `query` string or a `queries` array
  let queries: string[] = [];
  if (Array.isArray(req.body?.queries)) {
    queries = (req.body.queries as string[]).map((q: string) => q.trim()).filter(Boolean);
  } else {
    const single = ((req.body?.query as string) ?? '').trim();
    if (single) queries = [single];
  }

  if (queries.length === 0) {
    res.status(400).json({ error: 'At least one query is required.' });
    return;
  }

  const category = ((req.body?.category as string) ?? '').trim() || null;

  // Snapshot DB count to measure how many rows are added
  let countBefore = 0;
  try {
    const r = await getPool().query('SELECT COUNT(*) FROM listings');
    countBefore = parseInt(r.rows[0].count, 10);
  } catch { /* ignore */ }

  scrapeJob = {
    status:            'running',
    queries,
    currentQuery:      queries[0],
    currentQueryIndex: 1,
    totalQueries:      queries.length,
    category,
    startedAt:         new Date().toISOString(),
    finishedAt:        null,
    error:             null,
    saved:             0,
  };

  res.json({ ok: true, job: scrapeJob });

  // Run all queries sequentially in the background
  (async () => {
    try {
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        scrapeJob.currentQuery      = q;
        scrapeJob.currentQueryIndex = i + 1;
        console.log(`[Scrape] Query ${i + 1}/${queries.length}: "${q}"`);
        await runScraper(buildSearchUrl(q), category ?? undefined);
      }

      let saved = 0;
      try {
        const r = await getPool().query('SELECT COUNT(*) FROM listings');
        saved = parseInt(r.rows[0].count, 10) - countBefore;
      } catch { /* ignore */ }

      scrapeJob = { ...scrapeJob, status: 'done', finishedAt: new Date().toISOString(), saved };
      console.log(`[Scrape] All ${queries.length} queries done. New rows: ${saved}`);
    } catch (err) {
      scrapeJob = {
        ...scrapeJob,
        status:     'error',
        error:      (err as Error).message,
        finishedAt: new Date().toISOString(),
      };
      console.error('[Scrape] Job failed:', (err as Error).message);
    }
  })();
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
