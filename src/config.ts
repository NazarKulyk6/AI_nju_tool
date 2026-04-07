import dotenv from 'dotenv';
dotenv.config();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function envInt(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

function envBool(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (!v) return def;
  return v.toLowerCase() !== 'false' && v !== '0';
}

function envStr(key: string, def: string): string {
  return process.env[key] ?? def;
}

function envList(key: string, def: string): string[] {
  return envStr(key, def).split(',').map(s => s.trim()).filter(Boolean);
}

// ─── Exported Config ──────────────────────────────────────────────────────────

export const config = {

  // ── Browser ──────────────────────────────────────────────────────────────────
  // SCRAPER_HEADLESS=false  → run with a visible window (default, needed in Docker via Xvfb)
  // SCRAPER_HEADLESS=true   → fully headless (faster, no Xvfb needed)
  headless: envBool('SCRAPER_HEADLESS', false),

  // Browser locale and timezone (affects Accept-Language headers and JS Date)
  locale:   envStr('BROWSER_LOCALE',   'hr-HR'),
  timezone: envStr('BROWSER_TIMEZONE', 'Europe/Zagreb'),

  // ── Delays (milliseconds) ────────────────────────────────────────────────────
  delay: {
    // Pause after loading a search-results page (before extracting links)
    afterResultsPage: {
      min: envInt('DELAY_AFTER_RESULTS_PAGE_MIN', 1_500),
      max: envInt('DELAY_AFTER_RESULTS_PAGE_MAX', 3_000),
    },
    // Pause between search-results pages during link collection
    betweenPages: {
      min: envInt('DELAY_BETWEEN_PAGES_MIN', 2_000),
      max: envInt('DELAY_BETWEEN_PAGES_MAX', 5_000),
    },
    // Pause before opening each individual listing
    betweenListings: {
      min: envInt('DELAY_BETWEEN_LISTINGS_MIN', 500),
      max: envInt('DELAY_BETWEEN_LISTINGS_MAX', 2_000),
    },
    // Pause after loading a listing page (before extracting data)
    afterListing: {
      min: envInt('DELAY_AFTER_LISTING_MIN', 1_000),
      max: envInt('DELAY_AFTER_LISTING_MAX', 2_500),
    },
  },

  // ── Retry ────────────────────────────────────────────────────────────────────
  retry: {
    maxAttempts: envInt('RETRY_MAX_ATTEMPTS',  3),
    baseDelayMs: envInt('RETRY_BASE_DELAY_MS', 3_000),
  },

  // ── AI Backend ───────────────────────────────────────────────────────────────
  //
  //  AI_BACKEND=g4f     → use gpt4free Interference API (free, no API key needed)
  //  AI_BACKEND=gemini  → use Google Gemini API (requires GEMINI_API_KEY)
  //
  ai: {
    // Which backend to use: 'g4f' | 'gemini'
    backend: envStr('AI_BACKEND', 'g4f') as 'g4f' | 'gemini',

    // BullMQ worker concurrency — how many listings are analyzed in parallel.
    // G4F: safe to use 3–5. Gemini: keep at 1 (strict 30 RPM rate limit).
    concurrency: envInt('AI_CONCURRENCY', 3),

    // Delay applied inside each BullMQ job before the AI call (ms).
    // G4F: 300ms is enough. Gemini: keep ≥2000 (30 RPM limit).
    callDelayMs: envInt('AI_CALL_DELAY_MS', 300),

    // ── G4F (gpt4free) ─────────────────────────────────────────────────────────
    // Runs as a separate Docker service exposing an OpenAI-compatible REST API.
    // Internally accessible at http://g4f:8080/v1 (Docker network).
    // Externally accessible at http://localhost:1337/v1.
    g4f: {
      // Base URL of the g4f Interference API
      baseUrl: envStr('G4F_BASE_URL', 'http://g4f:8080/v1'),
      // Model to use for listing classification (analyzer)
      analyzerModel: envStr('G4F_ANALYZER_MODEL', 'gpt-4o-mini'),
      // Model to use for search query suggestions (scraper page)
      suggestModel:  envStr('G4F_SUGGEST_MODEL',  'gpt-4o-mini'),
    },

    // ── Gemini ─────────────────────────────────────────────────────────────────
    // Uses Google's Generative Language API.
    // Falls back through models if one hits a quota limit.
    gemini: {
      // Models tried in order for listing classification (highest free RPD first)
      analyzerModels: envList(
        'GEMINI_ANALYZER_MODELS',
        'gemma-3-27b-it,gemma-3-12b-it,gemini-3.1-flash-lite-preview,gemini-2.5-flash',
      ),
      // Models tried in order for query suggestion
      suggestModels: envList(
        'GEMINI_SUGGEST_MODELS',
        'gemini-3.1-flash-lite-preview,gemma-3-27b-it,gemini-2.5-flash,gemma-3-12b-it',
      ),
      // Max retries per model on transient 429 errors (exponential back-off)
      retryAttempts: envInt('GEMINI_RETRY_ATTEMPTS', 4),
    },
  },
};
