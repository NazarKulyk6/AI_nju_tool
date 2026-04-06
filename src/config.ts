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
};
