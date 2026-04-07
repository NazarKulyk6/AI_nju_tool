/**
 * queue.ts — BullMQ-based AI analysis queue
 *
 * Why Redis/BullMQ at scale (6 000+ listings):
 *   • Jobs survive server restarts (persisted in Redis with AOF)
 *   • Built-in per-job retry with exponential back-off
 *   • Accurate progress via job counts (no in-memory bookkeeping)
 *   • Horizontally scalable: add more worker containers later
 *   • Pause / resume / inspect / retry failed jobs via BullMQ UI
 *
 * Job lifecycle:
 *   waiting → active → completed
 *                    ↘ failed (retried up to MAX_ATTEMPTS, then stays failed)
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';
import {
  analyzeWithAI,
  getListingById,
  saveAnalyzedItems,
  markListingProcessed,
} from './ai_analyzer';
import { sleep } from './utils';

// ─── Redis connections ─────────────────────────────────────────────────────────
// BullMQ requires separate IORedis instances for Queue, Worker, and QueueEvents.

function makeRedis(): IORedis {
  return new IORedis({
    host: process.env.REDIS_HOST ?? 'redis',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  });
}

// ─── Queue definition ──────────────────────────────────────────────────────────

export const QUEUE_NAME = 'analyze-listings';

export interface ListingJobData {
  listingId: number;
  title:     string | null;
  url:       string;
}

export interface ListingJobResult {
  items: number;
}

const queueConn = makeRedis();

export const analyzeQueue = new Queue<ListingJobData, ListingJobResult>(QUEUE_NAME, {
  connection: queueConn,
  defaultJobOptions: {
    attempts:  3,                                      // try up to 3 times
    backoff:   { type: 'exponential', delay: 5_000 }, // 5s → 10s → 20s
    removeOnComplete: { count: 20_000 },               // keep last 20k completed
    removeOnFail:     false,                           // keep ALL failed for inspection
  },
});

// ─── Worker ────────────────────────────────────────────────────────────────────

const workerConn = makeRedis();

export const analyzeWorker = new Worker<ListingJobData, ListingJobResult>(
  QUEUE_NAME,
  async (job: Job<ListingJobData, ListingJobResult>) => {
    const listing = await getListingById(job.data.listingId);
    if (!listing) throw new Error(`Listing #${job.data.listingId} not found in DB`);

    // Small delay between calls to avoid hitting provider rate limits
    if (config.ai.callDelayMs > 0) await sleep(config.ai.callDelayMs);

    const items = await analyzeWithAI(listing);
    await saveAnalyzedItems(job.data.listingId, items, items);
    await markListingProcessed(job.data.listingId);

    return { items: items.length };
  },
  {
    connection:  workerConn,
    concurrency: config.ai.concurrency,  // process N jobs simultaneously
  },
);

analyzeWorker.on('completed', (job: Job<ListingJobData, ListingJobResult>, result: ListingJobResult) => {
  console.log(`[Queue] ✓ #${job.data.listingId} "${job.data.title ?? ''}" → ${result.items} item(s)`);
});

analyzeWorker.on('failed', (job: Job<ListingJobData, ListingJobResult> | undefined, err: Error) => {
  if (!job) return;
  const attempts    = job.attemptsMade;
  const maxAttempts = job.opts.attempts ?? 3;
  if (attempts >= maxAttempts) {
    console.error(`[Queue] ✗ #${job.data.listingId} FAILED after ${maxAttempts} attempt(s): ${err.message}`);
  } else {
    console.warn(`[Queue] ↺ #${job.data.listingId} attempt ${attempts}/${maxAttempts} failed — will retry: ${err.message}`);
  }
});

analyzeWorker.on('error', (err: Error) => {
  console.error('[Queue] Worker error:', err.message);
});

// ─── Session meta (lightweight; only startedAt / finishedAt / total) ──────────
// The authoritative job state lives in Redis; this is just for the status API.

interface SessionMeta {
  total:      number;
  startedAt:  string | null;
  finishedAt: string | null;
}

let sessionMeta: SessionMeta = { total: 0, startedAt: null, finishedAt: null };

// Detect when all jobs are done and stamp finishedAt
const eventsConn  = makeRedis();
const queueEvents = new QueueEvents(QUEUE_NAME, { connection: eventsConn });

queueEvents.on('drained', () => {
  // 'drained' = waiting queue is empty. Active jobs may still be running.
  // Poll briefly until active count also hits 0.
  const check = async (attempt = 0) => {
    const { active, waiting } = await analyzeQueue.getJobCounts('active', 'waiting');
    if (waiting === 0 && active === 0) {
      if (!sessionMeta.finishedAt) {
        sessionMeta.finishedAt = new Date().toISOString();
        const { completed, failed } = await analyzeQueue.getJobCounts('completed', 'failed');
        console.log(`[Queue] All done. ✓ ${completed}  ✗ ${failed}`);
      }
    } else if (attempt < 20) {
      setTimeout(() => check(attempt + 1), 500);
    }
  };
  setTimeout(() => check(), 200);
});

// ─── Public helpers ────────────────────────────────────────────────────────────

/** Start a new analysis run.  Clears any previous queue state first. */
export async function startAnalysis(
  listings: Array<{ id: number; title: string | null; url: string }>,
): Promise<void> {
  // Remove all previous jobs (clean slate for each run)
  await analyzeQueue.obliterate({ force: true });

  sessionMeta = {
    total:      listings.length,
    startedAt:  new Date().toISOString(),
    finishedAt: null,
  };

  // addBulk is atomic and much faster than calling add() in a loop
  await analyzeQueue.addBulk(
    listings.map(l => ({
      name: 'listing',
      data: { listingId: l.id, title: l.title, url: l.url },
    })),
  );

  console.log(`[Queue] Enqueued ${listings.length} listings  (concurrency=${config.ai.concurrency})`);
}

/** Returns the current queue/job status for the /api/analyze/status endpoint. */
export async function getAnalyzeStatus() {
  const counts = await analyzeQueue.getJobCounts('waiting', 'active', 'completed', 'failed');
  const isRunning = counts.waiting > 0 || counts.active > 0;
  const hasRun    = sessionMeta.startedAt !== null;

  // Show one of the active jobs in the UI ("currently processing…")
  let currentId:    number | null = null;
  let currentTitle: string | null = null;
  if (counts.active > 0) {
    const [activeJob] = await analyzeQueue.getActive(0, 0);
    if (activeJob) {
      currentId    = activeJob.data.listingId;
      currentTitle = activeJob.data.title;
    }
  }

  const allFailed = hasRun && !isRunning && counts.completed === 0 && counts.failed > 0;

  return {
    status:       !hasRun    ? 'idle'
                : isRunning  ? 'running'
                : allFailed  ? 'error'
                :              'done',

    total:        sessionMeta.total,
    done:         counts.completed,
    failed:       counts.failed,
    active:       counts.active,
    waiting:      counts.waiting,

    currentId,
    currentTitle,

    startedAt:    sessionMeta.startedAt,
    finishedAt:   isRunning ? null : sessionMeta.finishedAt,
    error:        allFailed ? 'All listings failed to analyze' : null,
    concurrency:  config.ai.concurrency,
  };
}
