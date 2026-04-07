import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { getPool, initDb } from './db';
import { runScraper, ScraperProgress } from './scraper';
import { buildSearchUrl, sleep } from './utils';
import {
  getUnprocessedListings,
  analyzeWithAI,
  saveAnalyzedItems,
  markListingProcessed,
} from './ai_analyzer';
import { startAnalysis, getAnalyzeStatus } from './queue';
import { config } from './config';

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

// Analyze job state is now managed by BullMQ (src/queue.ts).
// Use getAnalyzeStatus() for reads, startAnalysis() to enqueue.

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

// ─── API: AI — expand search query into Croatian search terms ─────────────────
//
//  Supports two backends (controlled by AI_BACKEND env var):
//    'g4f'    → gpt4free Interference API (no API key needed)
//    'gemini' → Google Gemini API (requires GEMINI_API_KEY)
//
app.post('/api/suggest-queries', async (req: Request, res: Response) => {
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

  // ── Helper: parse a JSON string array from raw LLM text ────────────────────
  function parseTerms(raw: string): string[] | null {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      const arr: string[] = JSON.parse(match[0]);
      return [...new Set(arr.map((t: string) => t.trim().toLowerCase()).filter(Boolean))];
    } catch {
      return null;
    }
  }

  // ── G4F backend ────────────────────────────────────────────────────────────
  if (config.ai.backend === 'g4f') {
    const { baseUrl, suggestModel } = config.ai.g4f;
    try {
      const fetchRes = await fetch(`${baseUrl}/chat/completions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:       suggestModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          max_tokens:  512,
        }),
      });

      if (!fetchRes.ok) {
        const errBody = await fetchRes.text();
        res.status(502).json({ error: `G4F error ${fetchRes.status}: ${errBody.slice(0, 200)}` });
        return;
      }

      const data = await fetchRes.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw   = data.choices?.[0]?.message?.content ?? '';
      const terms = parseTerms(raw);
      if (!terms) {
        res.status(502).json({ error: 'G4F returned an unexpected format. Try again.' });
        return;
      }
      console.log(`[G4F/${suggestModel}] Expanded "${userInput}" → ${terms.length} terms`);
      res.json({ terms });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const isNetworkErr = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND');
      const friendly = isNetworkErr
        ? `G4F service is unreachable (${msg}). Make sure it is running: docker compose --profile ai up -d g4f`
        : msg;
      console.error('[G4F] suggest-queries error:', msg);
      res.status(500).json({ error: friendly });
    }
    return;
  }

  // ── Gemini backend ─────────────────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    res.status(503).json({ error: 'GEMINI_API_KEY is not configured. Set AI_BACKEND=g4f to use gpt4free instead.' });
    return;
  }

  const { suggestModels, retryAttempts } = config.ai.gemini;
  const geminiUrl = (model: string) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  for (let modelIdx = 0; modelIdx < suggestModels.length; modelIdx++) {
    const model = suggestModels[modelIdx];

    const bodyPayload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
    });

    let fetchRes: Awaited<ReturnType<typeof fetch>>;
    try {
        fetchRes = await fetch(geminiUrl(model), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyPayload,
        });
      } catch (err) {
        const msg = (err as Error).message ?? '';
        console.error(`[Gemini/${model}] Network error:`, msg);
        res.status(500).json({ error: `Network error reaching Gemini API: ${msg}` });
        return;
      }

    if (fetchRes.status === 429) {
      const errBody = await fetchRes.text();
      if (errBody.includes('limit: 0') && modelIdx + 1 < suggestModels.length) {
        console.warn(`[Gemini/${model}] Zero quota — switching to next model…`);
        continue;
      }
      // Transient 429: wait and retry once
      const waitMs = (() => {
        const h = fetchRes.headers.get('Retry-After');
        return h ? parseInt(h, 10) * 1_000 : 15_000;
      })();
      console.warn(`[Gemini/${model}] 429 — waiting ${waitMs / 1_000}s…`);
      await sleep(waitMs);

      try {
        fetchRes = await fetch(geminiUrl(model), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyPayload,
        });
      } catch (err) { res.status(500).json({ error: (err as Error).message }); return; }

      if (fetchRes.status === 429) {
        if (modelIdx + 1 < suggestModels.length) { console.warn(`[Gemini/${model}] Still 429 — next model…`); continue; }
        res.status(429).json({ error: 'All Gemini models are rate-limited. Try again in a minute or switch to G4F backend.' });
        return;
      }
    }

    if (!fetchRes.ok) {
      const errBody = await fetchRes.text();
      console.error(`[Gemini/${model}] Error ${fetchRes.status}:`, errBody.slice(0, 200));
      if (modelIdx + 1 < suggestModels.length) continue;
      res.status(502).json({ error: `Gemini API error ${fetchRes.status}: ${errBody.slice(0, 200)}` });
      return;
    }

    const data = await fetchRes.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw   = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const terms = parseTerms(raw);
    if (!terms) {
      console.error(`[Gemini/${model}] Could not parse JSON:`, raw.slice(0, 200));
      if (modelIdx + 1 < suggestModels.length) continue;
      res.status(502).json({ error: 'Gemini returned an unexpected format. Try again.' });
      return;
    }

    console.log(`[Gemini/${model}] Expanded "${userInput}" → ${terms.length} terms`);
    res.json({ terms });
    return;
  }

  res.status(502).json({ error: 'All Gemini models failed. Check your API key and quota.' });
});

// ─── API: Count unprocessed listings ─────────────────────────────────────────
app.get('/api/analyze/count', async (_req: Request, res: Response) => {
  try {
    const r = await getPool().query(
      `SELECT COUNT(*) AS count FROM listings WHERE processed = FALSE`,
    );
    res.json({ count: parseInt(r.rows[0].count, 10) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── API: Analyze job status ──────────────────────────────────────────────────
app.get('/api/analyze/status', async (_req: Request, res: Response) => {
  try {
    res.json(await getAnalyzeStatus());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── API: Start AI analysis of already-scraped listings ───────────────────────
app.post('/api/analyze', async (req: Request, res: Response) => {
  try {
    const current = await getAnalyzeStatus();
    if (current.status === 'running') {
      res.status(409).json({ error: 'Analyzer already running', job: current });
      return;
    }

    const listings = await getUnprocessedListings();
    if (listings.length === 0) {
      res.json({ ok: true, message: 'No unprocessed listings found.', job: current });
      return;
    }

    // Enqueue all unprocessed listings into Redis.
    // The BullMQ worker (src/queue.ts) picks them up immediately.
    await startAnalysis(listings.map(l => ({ id: l.id, title: l.title, url: l.url })));

    res.json({ ok: true, job: await getAnalyzeStatus() });
  } catch (err) {
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

// ─── API: Analyzer stats ──────────────────────────────────────────────────────
app.get('/api/analyzed-stats', async (_req: Request, res: Response) => {
  try {
    const pool = getPool();
    const [items, pending, analyzed, cats] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM analyzed_items`),
      pool.query(`SELECT COUNT(*) AS count FROM listings WHERE processed = FALSE`),
      pool.query(`SELECT COUNT(*) AS count FROM listings WHERE processed = TRUE`),
      pool.query(`
        SELECT category, COUNT(*) AS count
        FROM analyzed_items
        GROUP BY category ORDER BY count DESC
      `),
    ]);
    res.json({
      total_items:         parseInt(items.rows[0].count,    10),
      pending_listings:    parseInt(pending.rows[0].count,  10),
      analyzed_listings:   parseInt(analyzed.rows[0].count, 10),
      categories:          cats.rows,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── API: Browse analyzed items ───────────────────────────────────────────────
app.get('/api/analyzed-items', async (req: Request, res: Response) => {
  const category    = ((req.query.category    as string) ?? '').trim() || null;
  const subcategory = ((req.query.subcategory as string) ?? '').trim() || null;
  const type        = ((req.query.type        as string) ?? '').trim() || null;
  const q           = ((req.query.q           as string) ?? '').trim() || null;
  const page        = Math.max(1, parseInt((req.query.page  as string) ?? '1',  10));
  const limit       = Math.min(48, Math.max(1, parseInt((req.query.limit as string) ?? '24', 10)));
  const offset      = (page - 1) * limit;

  try {
    const pool = getPool();
    const conds: string[] = [];
    const params: unknown[] = [];

    if (category)    { params.push(category);    conds.push(`ai.category    = $${params.length}`); }
    if (subcategory) { params.push(subcategory);  conds.push(`ai.subcategory = $${params.length}`); }
    if (type)        { params.push(type);          conds.push(`ai.type        = $${params.length}`); }
    if (q)           { params.push(`%${q}%`);      conds.push(`ai.title ILIKE $${params.length}`); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const dataQ = `
      SELECT ai.id, ai.listing_id, ai.category, ai.subcategory, ai.type,
             ai.title, ai.price, ai.capacity_gb, ai.ram_gb, ai.cpu, ai.storage_gb,
             ai.created_at, l.url
      FROM analyzed_items ai
      LEFT JOIN listings l ON l.id = ai.listing_id
      ${where}
      ORDER BY ai.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const [rows, count] = await Promise.all([
      pool.query(dataQ, [...params, limit, offset]),
      pool.query(`SELECT COUNT(*) FROM analyzed_items ai ${where}`, params),
    ]);

    const total      = parseInt(count.rows[0].count, 10);
    const totalPages = Math.ceil(total / limit);
    res.json({ data: rows.rows, pagination: { page, limit, total, totalPages } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Page routes ──────────────────────────────────────────────────────────────
app.get('/scraper', (_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, 'scraper.html'));
});

app.get('/analyzer', (_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, 'analyzer.html'));
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
