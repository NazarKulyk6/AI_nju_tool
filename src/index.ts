import dotenv from 'dotenv';
dotenv.config();

import { initDb, closeDb } from './db';
import { runScraper } from './scraper';
import { buildSearchUrl, prompt } from './utils';

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║        Njuskalo.hr Scraper v1.0           ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  // 1. Ask user for a search query
  const query = await prompt('Enter search query (e.g. "ssd", "mac mini", "car"): ');

  if (!query) {
    console.error('[Main] No search query provided. Exiting.');
    process.exit(1);
  }

  const searchUrl = buildSearchUrl(query);
  console.log(`\n[Main] Search URL: ${searchUrl}\n`);

  // 2. Initialise database (create table if not exists)
  try {
    await initDb();
  } catch (err) {
    console.error('[Main] Failed to initialise database:', (err as Error).message);
    process.exit(1);
  }

  // 3. Run the two-stage scraper
  try {
    await runScraper(searchUrl);
  } catch (err) {
    console.error('[Main] Unhandled scraper error:', (err as Error).message);
  } finally {
    // 4. Always close the DB pool
    await closeDb();
  }

  console.log('\n[Main] All done. Goodbye!');
}

// Graceful shutdown on SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  console.log('\n[Main] SIGINT received — shutting down …');
  await closeDb();
  process.exit(0);
});

main().catch((err) => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});
