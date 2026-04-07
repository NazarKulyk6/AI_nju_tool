import { Browser, BrowserContext, Page, chromium } from 'playwright';
import {
  Listing,
  saveToDb,
  enqueuePendingUrl,
  fetchPendingUrls,
  countPendingUrls,
  countSkippedUrls,
  markUrlProcessed,
  cleanupPendingUrls,
} from './db';
import {
  randomDelay,
  humanScroll,
  randomUserAgent,
  withRetry,
  dedupe,
} from './utils';
import { config } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScraperContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export interface ScraperProgress {
  stage:        'collecting' | 'parsing';
  // Stage 1
  linksFound:   number;   // unique URLs collected so far (all queries combined)
  pagesScanned: number;   // search-result pages visited  (all queries combined)
  linksSkipped: number;   // URLs already in DB for this category (will be skipped)
  // Stage 2
  totalLinks:   number;   // URLs that will actually be parsed
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
    headless: config.headless,
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
    locale:     config.locale,
    timezoneId: config.timezone,
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': `${config.locale},${config.locale.split('-')[0]};q=0.9,en-US;q=0.8,en;q=0.7`,
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

  // Block heavy resource types for ALL pages in this context (images, media, fonts)
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  const page = await context.newPage();

  console.log(`[Browser] Launched with UA: ${userAgent}`);
  return { browser, context, page };
}

// ─── Stage 1: Per-Page Link Collection ───────────────────────────────────────

/**
 * Collect listing URLs from ONE search-results page.
 * Returns the list of URLs found on this page.
 * Stops pagination when the page returns 0 results (no DOM "next" check needed).
 */
async function getUrlsFromResultsPage(
  page: Page,
  url: string,
  pageNum: number,
): Promise<string[]> {
  console.log(`\n[Stage 1] Loading results page ${pageNum}: ${url}`);

  await withRetry(async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }, config.retry.maxAttempts, config.retry.baseDelayMs);

  await dismissCookieBanner(page);
  // No humanScroll here — Stage 1 only collects links, no need to simulate reading
  await randomDelay(config.delay.afterResultsPage.min, config.delay.afterResultsPage.max);

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
  return urls;
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
  }, config.retry.maxAttempts, config.retry.baseDelayMs);

  await dismissCookieBanner(page);
  await humanScroll(page);
  await randomDelay(config.delay.afterListing.min, config.delay.afterListing.max);

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

// ─── Stage 1 (exported): Collect links for ONE query ──────────────────────────
//
// Opens its own browser, paginates through ALL result pages until an empty page
// is returned (no DOM "next button" detection — more reliable for njuskalo.hr).
// Enqueues every found URL into the shared pending_urls bucket `jid`.
//
// `onProgress` reports per-query counts (linksFound / pagesScanned).
//

export async function collectLinksForQuery(
  searchUrl: string,
  jid: string,
  onProgress?: (p: ScraperProgress) => void,
): Promise<void> {
  const { browser, page } = await createBrowser();

  const progress: ScraperProgress = {
    stage:        'collecting',
    linksFound:   0,
    pagesScanned: 0,
    linksSkipped: 0,
    totalLinks:   0,
    linksParsed:  0,
    currentUrl:   '',
  };

  const report = () => { if (onProgress) onProgress({ ...progress }); };

  try {
    let pageNum = 1;
    const MAX_PAGES = 200; // safety cap

    while (pageNum <= MAX_PAGES) {
      const resultsUrl = pageNum === 1
        ? searchUrl
        : (() => {
            const u = new URL(searchUrl);
            u.searchParams.set('page', String(pageNum));
            return u.toString();
          })();

      progress.currentUrl = resultsUrl;

      const urls = await getUrlsFromResultsPage(page, resultsUrl, pageNum);

      // Stop when page is empty — no need to check DOM "next" button
      if (urls.length === 0) {
        console.log(`[Stage 1] Page ${pageNum} is empty — collection complete.`);
        break;
      }

      for (const url of urls) {
        await enqueuePendingUrl(jid, url);
      }

      const totalFound = await countPendingUrls(jid);
      progress.pagesScanned = pageNum;
      progress.linksFound   = totalFound;
      report();

      console.log(`[Stage 1] Page ${pageNum} done. Total URLs in queue: ${totalFound}`);

      pageNum++;
      await randomDelay(config.delay.betweenPages.min, config.delay.betweenPages.max);
    }

    const totalQueued = await countPendingUrls(jid);
    console.log(`[Stage 1] Query done: ${totalQueued} total URLs queued.`);
  } finally {
    await browser.close();
    console.log('[Browser] Closed after Stage 1.');
  }
}

// ─── Stage 2 (exported): Parse all queued links for a job ─────────────────────
//
// Opens its own browser, fetches all pending URLs from DB for `jid`,
// filters out already-scraped ones for this category, and parses each listing.
//

export async function parseQueuedLinks(
  jid: string,
  category: string | null | undefined,
  onProgress?: (p: ScraperProgress) => void,
): Promise<void> {
  const { browser, context } = await createBrowser();

  const progress: ScraperProgress = {
    stage:        'parsing',
    linksFound:   0,
    pagesScanned: 0,
    linksSkipped: 0,
    totalLinks:   0,
    linksParsed:  0,
    currentUrl:   '',
  };

  const report = () => { if (onProgress) onProgress({ ...progress }); };

  try {
    const cat = category ?? null;

    const urlsToProcess = await fetchPendingUrls(jid, cat);
    const skipped       = await countSkippedUrls(jid, cat);

    progress.linksSkipped = skipped;
    progress.totalLinks   = urlsToProcess.length;
    report();

    console.log(`\n[Scraper] ══ STAGE 2: Parsing ${urlsToProcess.length} listings (skipped ${skipped} already in DB) ══`);

    if (urlsToProcess.length === 0) {
      console.log('[Stage 2] Nothing new to parse.');
      return;
    }

    // ── Parallel worker pool ──────────────────────────────────────────────────
    const concurrency  = Math.max(1, config.scraper.concurrency);
    const total        = urlsToProcess.length;
    const urlQueue     = [...urlsToProcess]; // shared queue consumed by all workers
    let   linksParsed  = 0;
    let   totalSuccess = 0;
    let   totalFail    = 0;

    console.log(`[Stage 2] Concurrency: ${concurrency} tab(s)`);

    // Create one browser page per worker (route blocking already on context)
    const workerPages = await Promise.all(
      Array.from({ length: concurrency }, () => context.newPage()),
    );

    const runWorker = async (workerPage: Page, workerId: number): Promise<void> => {
      while (true) {
        const url = urlQueue.shift();
        if (!url) break;  // queue exhausted

        const currentIdx = total - urlQueue.length; // 1-based position
        progress.currentUrl = url;
        progress.linksParsed = linksParsed;
        report();

        console.log(`\n[Stage 2][w${workerId}] ${currentIdx}/${total}: ${url}`);

        await randomDelay(config.delay.betweenListings.min, config.delay.betweenListings.max);

        try {
          const listing = await parseListing(workerPage, url);
          listing.category = category ?? null;
          await saveToDb(listing);
          await markUrlProcessed(jid, url);
          totalSuccess++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[Stage 2][w${workerId}] Failed: ${message}`);
          totalFail++;
        }

        linksParsed++;
        console.log(`[Stage 2][w${workerId}] Progress: ${linksParsed}/${total} (saved: ${totalSuccess}, failed: ${totalFail})`);
      }
    };

    // Run all workers in parallel
    await Promise.all(workerPages.map((wp, i) => runWorker(wp, i + 1)));

    progress.linksParsed = total;
    report();

    console.log(`\n[Scraper] ══ STAGE 2 DONE: saved ${totalSuccess}, failed ${totalFail} ══`);
  } finally {
    await browser.close();
    console.log('[Browser] Closed after Stage 2.');
    await cleanupPendingUrls(jid);
  }
}

// ─── runScraper: single-query convenience wrapper (used by legacy callers) ────

export async function runScraper(
  searchUrl: string,
  category?: string,
  onProgress?: (p: ScraperProgress) => void,
  jobId?: string,
): Promise<void> {
  const jid = jobId ?? `job_${Date.now()}`;

  await collectLinksForQuery(searchUrl, jid, onProgress);
  await parseQueuedLinks(jid, category ?? null, onProgress);
}
