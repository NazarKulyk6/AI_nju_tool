import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { getPool, initDb } from './db';
import { runScraper, ScraperProgress } from './scraper';
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
  // Progress
  stage:             'collecting' | 'parsing' | null;
  linksFound:        number;   // stage 1: URLs collected so far
  pagesScanned:      number;   // stage 1: search-result pages visited
  linksSkipped:      number;   // URLs already in DB for this category → skipped
  totalLinks:        number;   // stage 2: URLs that will actually be parsed
  linksParsed:       number;   // stage 2: URLs parsed so far
  currentUrl:        string;   // URL being processed right now
  // Multi-query tracking
  queries:           string[];
  currentQuery:      string;
  currentQueryIndex: number;
  totalQueries:      number;
  category:          string | null;
  // Timing
  startedAt:         string | null;
  finishedAt:        string | null;
  // Result
  error:             string | null;
  saved:             number;
}

let scrapeJob: ScrapeJob = {
  status:            'idle',
  stage:             null,
  linksFound:        0,
  pagesScanned:      0,
  linksSkipped:      0,
  totalLinks:        0,
  linksParsed:       0,
  currentUrl:        '',
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

// ─── API: Gemini — expand search query into Croatian search terms ─────────────
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

  // Models ordered by preference (highest free-tier RPD first).
  // Each model is tried in sequence; if one returns 429 we move to the next.
  // Per AI Studio quota (Apr 2026):
  //   gemini-3.1-flash-lite-preview → 15 RPM, 500 RPD
  //   gemma-3-27b-it                → 30 RPM, 14 400 RPD
  //   gemini-2.5-flash              →  5 RPM,    20 RPD
  const GEMINI_MODELS = [
    'gemini-3.1-flash-lite-preview',
    'gemma-3-27b-it',
    'gemini-2.5-flash',
    'gemma-3-12b-it',
  ];
  const geminiUrl = (model: string) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (let modelIdx = 0; modelIdx < GEMINI_MODELS.length; modelIdx++) {
    const model = GEMINI_MODELS[modelIdx];
    let fetchRes: Awaited<ReturnType<typeof fetch>>;
    try {
      fetchRes = await fetch(geminiUrl(model), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
        }),
      });
    } catch (err) {
      console.error(`[Gemini/${model}] Network error:`, (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
      return;
    }

    // 429 with limit:0 means this model has no quota → try the next one
    if (fetchRes.status === 429) {
      const errBody = await fetchRes.text();
      const isZeroQuota = errBody.includes('limit: 0');

      if (isZeroQuota && modelIdx + 1 < GEMINI_MODELS.length) {
        console.warn(`[Gemini/${model}] Zero quota — switching to next model…`);
        continue;
      }

      // Transient rate-limit: wait and retry the same model once
      const retryAfterHeader = fetchRes.headers.get('Retry-After');
      const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 15_000;
      console.warn(`[Gemini/${model}] 429 transient — waiting ${waitMs / 1000}s…`);
      await sleep(waitMs);

      // One more attempt with the same model
      try {
        fetchRes = await fetch(geminiUrl(model), {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
          }),
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }

      if (fetchRes.status === 429) {
        if (modelIdx + 1 < GEMINI_MODELS.length) {
          console.warn(`[Gemini/${model}] Still 429 — switching to next model…`);
          continue;
        }
        res.status(429).json({ error: 'All Gemini models are rate-limited. Try again in a minute.' });
        return;
      }
    }

    if (!fetchRes.ok) {
      const errBody = await fetchRes.text();
      console.error(`[Gemini/${model}] Error ${fetchRes.status}:`, errBody.slice(0, 200));
      // Try next model on server errors too
      if (modelIdx + 1 < GEMINI_MODELS.length) continue;
      res.status(502).json({ error: `Gemini API error ${fetchRes.status}: ${errBody.slice(0, 200)}` });
      return;
    }

    // ── Success ──────────────────────────────────────────────
    const data = await fetchRes.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const raw   = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      console.error(`[Gemini/${model}] Could not parse JSON:`, raw.slice(0, 200));
      if (modelIdx + 1 < GEMINI_MODELS.length) continue;   // try next model
      res.status(502).json({ error: 'Gemini returned an unexpected format. Try again.' });
      return;
    }

    try {
      const terms: string[] = JSON.parse(match[0]);
      const unique = [...new Set(terms.map((t: string) => t.trim().toLowerCase()).filter(Boolean))];
      console.log(`[Gemini/${model}] Expanded "${userInput}" → ${unique.length} terms`);
      res.json({ terms: unique });
    } catch {
      res.status(502).json({ error: 'Failed to parse Gemini response as JSON.' });
    }
    return;   // success — exit loop
  }

  // All models exhausted without success
  res.status(502).json({ error: 'All Gemini models failed. Check your API key and quota.' });
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

  // Snapshot DB count to measure new rows added
  let countBefore = 0;
  try {
    const r = await getPool().query('SELECT COUNT(*) FROM listings');
    countBefore = parseInt(r.rows[0].count, 10);
  } catch { /* ignore */ }

  // Unique ID for this job's pending_urls bucket
  const jobId = `job_${Date.now()}`;

  scrapeJob = {
    status:            'running',
    stage:             'collecting',
    linksFound:        0,
    pagesScanned:      0,
    linksSkipped:      0,
    totalLinks:        0,
    linksParsed:       0,
    currentUrl:        '',
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
        // Reset per-query progress counters for this new query
        scrapeJob.stage        = 'collecting';
        scrapeJob.linksFound   = 0;
        scrapeJob.pagesScanned = 0;
        scrapeJob.linksSkipped = 0;
        scrapeJob.totalLinks   = 0;
        scrapeJob.linksParsed  = 0;
        scrapeJob.currentUrl   = '';

        console.log(`\n[Scrape] ══ Query ${i + 1}/${queries.length}: "${q}" ══`);

        // Each query in the job gets its own sub-bucket: jobId_queryIndex
        const subJobId = `${jobId}_${i}`;

        await runScraper(
          buildSearchUrl(q),
          category ?? undefined,
          // Progress callback — update shared job state in real-time
          (p: ScraperProgress) => {
            scrapeJob.stage        = p.stage;
            scrapeJob.linksFound   = p.linksFound;
            scrapeJob.pagesScanned = p.pagesScanned;
            scrapeJob.linksSkipped = p.linksSkipped;
            scrapeJob.totalLinks   = p.totalLinks;
            scrapeJob.linksParsed  = p.linksParsed;
            scrapeJob.currentUrl   = p.currentUrl;
          },
          subJobId,
        );
      }

      let saved = 0;
      try {
        const r = await getPool().query('SELECT COUNT(*) FROM listings');
        saved = parseInt(r.rows[0].count, 10) - countBefore;
      } catch { /* ignore */ }

      scrapeJob = {
        ...scrapeJob,
        status:     'done',
        finishedAt: new Date().toISOString(),
        saved,
      };
      console.log(`\n[Scrape] All ${queries.length} queries done. New rows: ${saved}`);
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
