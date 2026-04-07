import dotenv from 'dotenv';
dotenv.config();

import { getPool, initDb, closeDb } from './db';
import { sleep } from './utils';
import { config } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawListing {
  id:          number;
  url:         string;
  title:       string | null;
  price:       string | null;
  info:        string | null;
  description: string | null;
  category:    string | null;
}

export interface AnalyzedItem {
  category:    string;
  subcategory: string;
  type:        string;
  title:       string;
  price:       number | null;
  capacity_gb?: number | null;
  ram_gb?:      number | null;
  cpu?:         string | null;
  storage_gb?:  number | null;
}

// ─── AI Prompt ────────────────────────────────────────────────────────────────

const AI_SYSTEM_PROMPT = `You are an AI that classifies and extracts structured data from classified ads.

INPUT:
- Title
- Price
- Info
- Description

TASK:
1. Determine main category (tier 1), subcategory (tier 2), product type (tier 3)
2. Extract ALL relevant products from the listing
3. If multiple products exist → return them as separate items

STRICT RULES:
- DO NOT invent categories outside the allowed list
- ALWAYS return at least one item
- DO NOT reject listings
- Ignore irrelevant accessories (cables, cases, etc.)
- Extract only meaningful sellable items

CATEGORY STRUCTURE  (TIER 1 → TIER 2 → TIER 3):

electronics:
  computers:    [laptop, desktop, mini_pc, other_computers]
  phones:       [smartphone, other_phones]
  audio:        [headphones, speakers, other_audio]
  tv:           [tv, other_tv]
  gaming:       [console, other_gaming]
  components:   [cpu, gpu, ram, motherboard, other_components]
  storage:      [ssd, hdd, usb, sd_card, other_storage]
  other:        [other_electronics]

vehicles:
  cars:         [car, other_cars]
  motorcycles:  [motorcycle, other_motorcycles]
  trucks:       [truck, other_trucks]
  boats:        [boat, other_boats]
  parts:        [car_part, other_parts]
  other:        [other_vehicles]

real_estate:
  all:          [apartment, house, land, rent_property, other_real_estate]

home:
  furniture:    [sofa, table, chair, other_furniture]
  appliances:   [washing_machine, fridge, other_appliances]
  tools:        [drill, saw, other_tools]
  garden:       [lawnmower, other_garden]
  other:        [other_home]

sports:
  fitness:      [treadmill, weights, other_fitness]
  cycling:      [bicycle, other_cycling]
  water_sports: [sup_board, swim_fins, kayak, other_water_sports]
  winter_sports:[skis, snowboard, other_winter_sports]
  outdoor:      [tent, backpack, other_outdoor]
  other:        [other_sports]

clothing:
  men:          [men_clothes, other_men]
  women:        [women_clothes, other_women]
  shoes:        [shoes, other_shoes]
  accessories:  [bag, watch, other_accessories]
  other:        [other_clothing]

kids:
  toys:         [toy, other_toys]
  strollers:    [stroller, other_strollers]
  clothes:      [kids_clothes, other_kids_clothes]
  other:        [other_kids]

animals:
  pets:         [animal, other_pets]
  equipment:    [pet_item, other_pet_items]
  other:        [other_animals]

services:
  repair:       [repair_service, other_repair]
  it:           [it_service, other_it]
  transport:    [transport_service, other_transport]
  education:    [education_service, other_education]
  other:        [other_services]

jobs:
  it:           [it_job, other_it_jobs]
  construction: [construction_job, other_construction]
  sales:        [sales_job, other_sales]
  other:        [other_jobs]

hobby:
  collectibles: [collectible, other_collectibles]
  music:        [instrument, other_music]
  books:        [book, other_books]
  other:        [other_hobby]

business:
  equipment:    [business_equipment, other_equipment]
  inventory:    [inventory, other_inventory]
  other:        [other_business]

other:
  other:        [unknown]

CLASSIFICATION RULES:
- If tier 3 (type) is unclear → use the corresponding "other_*" type
- If tier 2 (subcategory) is unclear → use category-level "other_*"
- If nothing matches → category="other", subcategory="other", type="unknown"

FIELDS (each item must include):
- category    (tier 1)
- subcategory (tier 2)
- type        (tier 3)
- title
- price       (number or null)

OPTIONAL FIELDS (include only if detectable):
- capacity_gb
- ram_gb
- cpu
- storage_gb

OUTPUT FORMAT — JSON ONLY, no markdown fences, no explanations:
{
  "items": [
    {
      "category": "electronics",
      "subcategory": "storage",
      "type": "ssd",
      "title": "SSD 512GB",
      "price": 35,
      "capacity_gb": 512
    }
  ]
}

FALLBACK (if nothing can be classified):
{
  "items": [
    {
      "category": "other",
      "subcategory": "other",
      "type": "unknown",
      "title": "<best guess from title>",
      "price": null
    }
  ]
}

NO explanations. ONLY JSON.

`;

function buildUserContent(listing: RawListing): string {
  return (
    `Title: ${listing.title ?? 'N/A'}\n` +
    `Price: ${listing.price ?? 'N/A'}\n` +
    `Info: ${listing.info ?? 'N/A'}\n` +
    `Description: ${listing.description ?? 'N/A'}\n` +
    `Category hint: ${listing.category ?? 'N/A'}`
  );
}

// ─── JSON extraction helper ────────────────────────────────────────────────────

function extractItems(rawText: string, source: string): AnalyzedItem[] {
  // Step 1: Strip markdown code fences  (```json ... ``` or ``` ... ```)
  let text = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Step 2: If the model wrapped JSON in prose, fish out the outermost {...}
  //   e.g. "Here is the result:\n{...}"  or  "Sure! {\"items\":[...]}"
  if (!text.startsWith('{')) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      text = jsonMatch[0];
    }
  }

  // Step 3: Parse
  let parsed: { items?: unknown[] };
  try {
    parsed = JSON.parse(text) as { items?: unknown[] };
  } catch {
    // Last-ditch: try to find an "items" array directly
    const arrMatch = text.match(/"items"\s*:\s*(\[[\s\S]*\])/);
    if (arrMatch) {
      try {
        const items = JSON.parse(arrMatch[1]) as unknown[];
        if (items.length > 0) return items as AnalyzedItem[];
      } catch { /* fall through */ }
    }
    throw new Error(`${source} returned invalid JSON:\n${text.slice(0, 500)}`);
  }

  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error(`${source} response has no items array`);
  }

  return parsed.items as AnalyzedItem[];
}

// ─── G4F backend (OpenAI-compatible Interference API) ─────────────────────────
//
//  Requires the g4f Docker service running on G4F_BASE_URL.
//  No API key needed — gpt4free handles provider selection internally.
//

async function callG4F(userContent: string): Promise<AnalyzedItem[]> {
  const { baseUrl, analyzerModel } = config.ai.g4f;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       analyzerModel,
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user',   content: userContent },
      ],
      temperature: 0.2,
      max_tokens:  1024,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`G4F API ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('G4F returned empty content');

  console.log(`[AI/G4F] Using model: ${analyzerModel}`);
  return extractItems(text, 'G4F');
}

// ─── Gemini backend ───────────────────────────────────────────────────────────
//
//  Tries each model in GEMINI_ANALYZER_MODELS in order.
//  Hard quota (limit: 0) → skip model.
//  Transient 429 → exponential back-off then retry.
//

async function callGemini(userContent: string): Promise<AnalyzedItem[]> {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const { analyzerModels, retryAttempts } = config.ai.gemini;
  const prompt = AI_SYSTEM_PROMPT + '\n---\n\nINPUT DATA:\n' + userContent;

  for (const model of analyzerModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
          }),
        });
      } catch (networkErr) {
        throw new Error(`Network error calling Gemini: ${(networkErr as Error).message}`);
      }

      // Hard quota on this model — try next
      if (res.status === 429) {
        const body = await res.text();
        if (body.includes('limit: 0')) {
          console.warn(`[AI/Gemini] Model ${model} has limit:0 — trying next model.`);
          break;
        }

        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1_000
          : Math.pow(2, attempt) * 2_000;  // 2s → 4s → 8s → 16s

        if (attempt < retryAttempts) {
          console.warn(`[AI/Gemini] 429 on ${model} (attempt ${attempt + 1}/${retryAttempts}). Waiting ${waitMs / 1_000}s…`);
          await sleep(waitMs);
          continue;
        }
        console.error(`[AI/Gemini] Rate limit persists for ${model} after all retries.`);
        break;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Gemini API ${res.status}: ${body.slice(0, 300)}`);
      }

      const json = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) throw new Error('Gemini returned empty text');

      console.log(`[AI/Gemini] Using model: ${model}`);
      return extractItems(text, `Gemini/${model}`);
    }
  }

  throw new Error('All Gemini models failed — could not analyze listing');
}

// ─── Unified LLM dispatcher ────────────────────────────────────────────────────

export async function analyzeWithAI(listing: RawListing): Promise<AnalyzedItem[]> {
  const userContent = buildUserContent(listing);
  if (config.ai.backend === 'g4f') {
    return callG4F(userContent);
  }
  return callGemini(userContent);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

export async function getListingById(id: number): Promise<RawListing | null> {
  const result = await getPool().query<RawListing>(
    `SELECT id, url, title, price, info, description, category
       FROM listings
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function countUnprocessedListings(): Promise<number> {
  const result = await getPool().query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM listings WHERE processed = FALSE`,
  );
  return parseInt(result.rows[0].cnt, 10);
}

/** Fetch the next `limit` unprocessed listings (oldest first). */
export async function getUnprocessedBatch(limit: number): Promise<RawListing[]> {
  const result = await getPool().query<RawListing>(
    `SELECT id, url, title, price, info, description, category
       FROM listings
      WHERE processed = FALSE
      ORDER BY id ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getUnprocessedListings(): Promise<RawListing[]> {
  return getUnprocessedBatch(100_000);  // legacy: fetch all
}

export async function saveAnalyzedItems(
  listingId: number,
  items:      AnalyzedItem[],
  raw:        unknown,
): Promise<void> {
  const client = await getPool().connect();
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await client.query(
        `INSERT INTO analyzed_items
           (listing_id, category, subcategory, type, title, price,
            capacity_gb, ram_gb, cpu, storage_gb, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          listingId,
          item.category    ?? null,
          item.subcategory ?? null,
          item.type        ?? null,
          item.title       ?? null,
          item.price       ?? null,
          item.capacity_gb ?? null,
          item.ram_gb      ?? null,
          item.cpu         ?? null,
          item.storage_gb  ?? null,
          i === 0 ? JSON.stringify(raw) : null,
        ],
      );
    }
  } finally {
    client.release();
  }
}

export async function markListingProcessed(listingId: number): Promise<void> {
  await getPool().query(
    `UPDATE listings SET processed = TRUE WHERE id = $1`,
    [listingId],
  );
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

export async function runAnalyzer(): Promise<void> {
  await initDb();

  const backend = config.ai.backend;
  const model   = backend === 'g4f' ? config.ai.g4f.analyzerModel : config.ai.gemini.analyzerModels[0];
  console.log(`[Analyzer] Backend: ${backend.toUpperCase()}, model hint: ${model}`);

  const listings = await getUnprocessedListings();
  console.log(`[Analyzer] Found ${listings.length} unprocessed listing(s).`);

  if (listings.length === 0) {
    console.log('[Analyzer] Nothing to do.');
    return;
  }

  let success = 0;
  let failed  = 0;

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    console.log(`\n[Analyzer] ${i + 1}/${listings.length} — listing #${listing.id}: ${listing.title ?? listing.url}`);

    try {
      const items = await analyzeWithAI(listing);
      await saveAnalyzedItems(listing.id, items, items);
      await markListingProcessed(listing.id);
      success++;
      console.log(`[Analyzer] ✓ Saved ${items.length} item(s) for listing #${listing.id}`);
    } catch (err) {
      failed++;
      console.error(`[Analyzer] ✗ Skipping listing #${listing.id}: ${(err as Error).message}`);
    }

    if (i < listings.length - 1) {
      await sleep(config.ai.callDelayMs);
    }
  }

  console.log(`\n[Analyzer] Done. Success: ${success}, Failed: ${failed}`);
}

// ─── Entry point (run directly: ts-node src/ai_analyzer.ts) ──────────────────

if (require.main === module) {
  (async () => {
    try {
      await runAnalyzer();
    } finally {
      await closeDb();
    }
  })().catch((err: Error) => {
    console.error('[Analyzer] Fatal:', err.message);
    process.exit(1);
  });
}
