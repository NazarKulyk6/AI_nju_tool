import * as readline from 'readline';
import { Page } from 'playwright';

// ─── Delay ────────────────────────────────────────────────────────────────────

/**
 * Wait for a random duration between minMs and maxMs milliseconds.
 */
export function randomDelay(minMs = 2_000, maxMs = 6_000): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  console.log(`[Util] Waiting ${ms}ms …`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for an exact number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Human-like Scroll ────────────────────────────────────────────────────────

/**
 * Slowly scroll the page to simulate a human reader.
 */
export async function humanScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalScrolled = 0;
      const distance = 300;
      const delay = 120;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalScrolled += distance;
        if (totalScrolled >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, delay);
    });
  });
}

// ─── Anti-Detection Headers ───────────────────────────────────────────────────

/** Common desktop User-Agent strings to rotate through. */
export const USER_AGENTS: string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
];

export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Retry Wrapper ────────────────────────────────────────────────────────────

/**
 * Retry an async operation up to `maxAttempts` times with exponential back-off.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 3_000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Retry] Attempt ${attempt}/${maxAttempts} failed: ${message}`);
      if (attempt < maxAttempts) {
        const backoff = baseDelayMs * attempt;
        console.log(`[Retry] Back-off ${backoff}ms before next attempt …`);
        await sleep(backoff);
      }
    }
  }
  throw lastError;
}

// ─── URL Helpers ──────────────────────────────────────────────────────────────

/**
 * Build the Njuskalo search URL for a given query string.
 */
export function buildSearchUrl(query: string): string {
  const encoded = encodeURIComponent(query.trim());
  return `https://www.njuskalo.hr/?ctl=search_ads&keywords=${encoded}`;
}

/**
 * Deduplicate an array of strings while preserving insertion order.
 */
export function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

// ─── CLI Prompt ───────────────────────────────────────────────────────────────

/**
 * Ask the user a question in the terminal and return their answer.
 */
export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
