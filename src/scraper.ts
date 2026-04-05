import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { Listing, saveToDb } from './db';
import {
  randomDelay,
  humanScroll,
  randomUserAgent,
  withRetry,
  dedupe,
} from './utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScraperContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export interface ScraperProgress {
  stage:        'collecting' | 'parsing';
  // Stage 1
  linksFound:   number;   // URLs collected so far (grows while paginating)
  pagesScanned: number;   // search-result pages visited
  // Stage 2
  totalLinks:   number;   // total URLs to parse (set when stage 1 finishes)
  linksParsed:  number;   // URLs already parsed
  currentUrl:   string;   // URL being processed right now
}

// ─── Browser Bootstrap ────────────────────────────────────────────────────────

/**
 * Launch a single Chromium browser with anti-detection measures applied.
 */
export async function createBrowser(): Promise<ScraperContext> {
  const userAgent = randomUserAgent();

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768',
    ],
  });

  const context = await browser.newContext({
    userAgent,
    locale: 'hr-HR',
    timezoneId: 'Europe/Zagreb',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'hr-HR,hr;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  // Mask navigator.webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // @ts-ignore
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['hr-HR', 'hr', 'en-US', 'en'],
    });
  });

  const page = await context.newPage();

  // Abort unnecessary resource types to speed up scraping
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  console.log(`[Browser] Launched with UA: ${userAgent}`);
  return { browser, context, page };
}

// ─── Stage 1: Per-Page Link Collection ───────────────────────────────────────

/**
 * Collect listing URLs from ONE search-results page.
 */
async function getUrlsFromResultsPage(
  page: Page,
  url: string,
  pageNum: number,
): Promise<{ urls: string[]; hasMore: boolean }> {
  console.log(`\n[Stage 1] Loading results page ${pageNum}: ${url}`);

  await withRetry(async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  });

  await dismissCookieBanner(page);
  await humanScroll(page);
  await randomDelay(1_500, 3_000);

  const urls = await page.evaluate((): string[] => {
    const anchors = Array.from(
      document.querySelectorAll(
        'article.entity-body a.entity-description-title, ' +
        'a.entity-description-title, ' +
        'h3.entity-title a, ' +
        '.classified-list-item a.entity-description-title',
      ),
    );
    return anchors
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((href) => href && href.includes('njuskalo.hr'));
  });

  console.log(`[Stage 1] Found ${urls.length} URLs on page ${pageNum}.`);

  if (urls.length === 0) return { urls: [], hasMore: false };

  const hasNextDom = await page.evaluate((): boolean => {
    const selectors = [
      'a[rel="next"]',
      '.pagination-next:not(.disabled) a',
      'li.next:not(.disabled) a',
      '.EntityList-paginationNext a',
      '.pagination .active + li:not(.disabled) a',
      'nav.pagination a[aria-label*="ext"]',
    ];
    return selectors.some((sel) => !!document.querySelector(sel));
  });

  return { urls, hasMore: hasNextDom };
}

// ─── Stage 2: Per-Listing Parsing ─────────────────────────────────────────────

/**
 * Navigate to a listing URL, extract all required fields, and return them.
 */
export async function parseListing(page: Page, url: string): Promise<Listing> {
  console.log(`[Stage 2] Parsing: ${url}`);

  await withRetry(async () => {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  });

  await dismissCookieBanner(page);
  await humanScroll(page);
  await randomDelay(1_000, 2_500);

  const title       = await getTitle(page);
  const price       = await getPrice(page);
  const info        = await getInfoBlock(page);
  const description = await getDescription(page);

  return { url, title, price, info, description, category: null };
}

// ─── Field Extractors ─────────────────────────────────────────────────────────

async function getTitle(page: Page): Promise<string | null> {
  try {
    const selectors = [
      'h1.ClassifiedDetailSummary-title',
      'h1.classified-title',
      'h1[itemprop="name"]',
      'h1',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.innerText();
        if (text.trim()) return text.trim();
      }
    }
  } catch (err) {
    console.warn('[Parser] getTitle error:', (err as Error).message);
  }
  return null;
}

async function getPrice(page: Page): Promise<string | null> {
  try {
    const selectors = [
      'dd.ClassifiedDetailSummary-priceDomestic',
      '.ClassifiedDetailSummary-priceRow dd',
      '.price-box strong',
      '.ClassifiedDetailSummary-price',
      '[itemprop="price"]',
      '.price strong',
      '.price-value',
      'strong.price',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.innerText();
        if (text.trim()) return text.trim();
      }
    }
  } catch (err) {
    console.warn('[Parser] getPrice error:', (err as Error).message);
  }
  return null;
}

/**
 * Extract the raw full text of the "Osnovne informacije" (basic info) block.
 */
export async function getInfoBlock(page: Page): Promise<string | null> {
  try {
    const result = await page.evaluate((): string | null => {
      const headings = Array.from(document.querySelectorAll('h2, h3, h4, strong, .section-title, .ClassifiedDetailBasicDetails-title'));
      for (const heading of headings) {
        const text = heading.textContent ?? '';
        if (/osnovne\s+informacije/i.test(text)) {
          const container =
            heading.closest('section') ??
            heading.closest('.ClassifiedDetailBasicDetails') ??
            heading.closest('.classified-details-section') ??
            heading.parentElement?.parentElement ??
            heading.parentElement;
          if (container) return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
        }
      }
      const knownSelectors = [
        '.ClassifiedDetailBasicDetails',
        '.classified-details-basic',
        '[data-section="basic-info"]',
        '.basic-info-section',
      ];
      for (const sel of knownSelectors) {
        const el = document.querySelector(sel);
        if (el) return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      }
      return null;
    });
    return result;
  } catch (err) {
    console.warn('[Parser] getInfoBlock error:', (err as Error).message);
    return null;
  }
}

/**
 * Extract the raw full text of the "Opis oglasa" (listing description) block.
 */
export async function getDescription(page: Page): Promise<string | null> {
  try {
    const result = await page.evaluate((): string | null => {
      const headings = Array.from(document.querySelectorAll('h2, h3, h4, strong, .section-title, .ClassifiedDetailDescription-title'));
      for (const heading of headings) {
        const text = heading.textContent ?? '';
        if (/opis\s+oglasa/i.test(text)) {
          const container =
            heading.closest('section') ??
            heading.closest('.ClassifiedDetailDescription') ??
            heading.closest('.classified-description') ??
            heading.parentElement?.parentElement ??
            heading.parentElement;
          if (container) return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
        }
      }
      const knownSelectors = [
        '.ClassifiedDetailDescription',
        '.classified-description',
        '[data-section="description"]',
        '.description-section',
        '.oglas-opis',
      ];
      for (const sel of knownSelectors) {
        const el = document.querySelector(sel);
        if (el) return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      }
      return null;
    });
    return result;
  } catch (err) {
    console.warn('[Parser] getDescription error:', (err as Error).message);
    return null;
  }
}

// ─── Cookie / Consent Banner ──────────────────────────────────────────────────

async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    const selectors = [
      'button#onetrust-accept-btn-handler',
      'button.onetrust-close-btn-handler',
      '[aria-label="Accept cookies"]',
      'button:has-text("Prihvati sve")',
      'button:has-text("Prihvaćam")',
      'button:has-text("Accept")',
      '.cookie-consent button',
      '#cookie-accept',
    ];
    for (const sel of selectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        console.log('[Browser] Cookie banner dismissed.');
        await page.waitForTimeout(800);
        return;
      }
    }
  } catch {
    // Banner not present — ignore silently
  }
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────

/**
 * Run the full two-stage scraping pipeline for a single search URL.
 *
 * Stage 1 — Link collection:
 *   Paginate through ALL search-results pages and collect every listing URL.
 *   Nothing is saved to the DB during this stage.
 *
 * Stage 2 — Listing parsing:
 *   Visit each collected URL, extract data, and save immediately to the DB.
 *
 * A `onProgress` callback is called after every significant state change so
 * that the web server can expose real-time status to the frontend.
 */
export async function runScraper(
  searchUrl: string,
  category?: string,
  onProgress?: (p: ScraperProgress) => void,
): Promise<void> {
  const { browser, page } = await createBrowser();

  const progress: ScraperProgress = {
    stage:        'collecting',
    linksFound:   0,
    pagesScanned: 0,
    totalLinks:   0,
    linksParsed:  0,
    currentUrl:   '',
  };

  const report = () => { if (onProgress) onProgress({ ...progress }); };

  try {
    // ── Stage 1: Collect ALL listing URLs ────────────────────────────────────
    console.log('\n[Scraper] ══ STAGE 1: Link collection ══');

    const allUrls: string[] = [];
    const seen = new Set<string>();
    let pageNum = 1;

    while (true) {
      const resultsUrl = pageNum === 1
        ? searchUrl
        : (() => {
            const u = new URL(searchUrl);
            u.searchParams.set('page', String(pageNum));
            return u.toString();
          })();

      const { urls, hasMore } = await getUrlsFromResultsPage(page, resultsUrl, pageNum);

      if (urls.length === 0) {
        console.log('[Stage 1] Empty page — collection complete.');
        break;
      }

      // Deduplicate across pages
      for (const url of urls) {
        if (!seen.has(url)) {
          seen.add(url);
          allUrls.push(url);
        }
      }

      progress.pagesScanned = pageNum;
      progress.linksFound   = allUrls.length;
      report();

      console.log(`[Stage 1] Page ${pageNum} done. Total URLs collected: ${allUrls.length}`);

      if (!hasMore) {
        console.log('[Stage 1] No next page — collection complete.');
        break;
      }

      pageNum++;
      await randomDelay(2_000, 5_000);
    }

    progress.totalLinks = allUrls.length;
    console.log(`\n[Scraper] ══ STAGE 1 DONE: ${allUrls.length} unique URLs collected ══`);

    if (allUrls.length === 0) {
      console.log('[Scraper] No listings found. Exiting.');
      return;
    }

    // ── Stage 2: Parse & save each listing ───────────────────────────────────
    console.log('\n[Scraper] ══ STAGE 2: Parsing listings ══');

    progress.stage       = 'parsing';
    progress.linksParsed = 0;
    report();

    let totalSuccess = 0;
    let totalFail    = 0;

    for (let i = 0; i < allUrls.length; i++) {
      const url = allUrls[i];

      progress.linksParsed = i;
      progress.currentUrl  = url;
      report();

      console.log(`\n[Stage 2] ${i + 1}/${allUrls.length}: ${url}`);

      await randomDelay(500, 2_000);

      try {
        const listing = await parseListing(page, url);
        listing.category = category ?? null;
        await saveToDb(listing);
        totalSuccess++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stage 2] Failed: ${message}`);
        totalFail++;
      }

      console.log(`[Stage 2] Progress: ${i + 1}/${allUrls.length} (saved: ${totalSuccess}, failed: ${totalFail})`);
    }

    progress.linksParsed = allUrls.length;
    report();

    console.log(`\n[Scraper] ══ STAGE 2 DONE: saved ${totalSuccess}, failed ${totalFail} ══`);
  } finally {
    await browser.close();
    console.log('[Browser] Closed.');
  }
}
