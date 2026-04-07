"""
G4F Bridge — FastAPI service wrapping the gpt4free Python client.

Features:
  • OpenAI-compatible REST API (POST /v1/chat/completions)
  • Per-provider concurrency semaphore:
      - If a provider is at its concurrency limit → skip to next immediately
      - Prevents 429 "Queue full" errors from PollinationsAI (max 1 concurrent)
  • Circuit breaker: after N consecutive request-level failures a provider is
    paused for RESET_AFTER_SEC seconds, then auto-retried
  • Providers are tried in order; first available healthy one wins

Provider spec format (G4F_PROVIDERS env var):
  "Provider:model:max_concurrent,Provider:model:max_concurrent,..."
  max_concurrent is optional (default: 1)

Example:
  G4F_PROVIDERS=PollinationsAI:openai-fast:1,Yqcloud:gpt-4:3

Routes:
  POST /v1/chat/completions
  GET  /v1/models
  GET  /health
  GET  /status   ← circuit-breaker + semaphore state
"""

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import List, Optional

import g4f.Provider as Providers
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from g4f.client import AsyncClient
from pydantic import BaseModel

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ─── Config ───────────────────────────────────────────────────────────────────

MAX_RETRIES:       int   = int(os.getenv("G4F_MAX_RETRIES",       "2"))
FAILURE_THRESHOLD: int   = int(os.getenv("G4F_FAILURE_THRESHOLD", "3"))
RESET_AFTER_SEC:   float = float(os.getenv("G4F_RESET_AFTER_SEC", "300"))
CALL_TIMEOUT:      float = float(os.getenv("G4F_CALL_TIMEOUT",    "60"))

# "Provider:model:max_concurrent,..."  (max_concurrent is optional, default 1)
G4F_PROVIDERS_RAW: str = os.getenv(
    "G4F_PROVIDERS",
    "PollinationsAI:openai-fast:1,Yqcloud:gpt-4:3",
)

# ─── Provider state ───────────────────────────────────────────────────────────

@dataclass
class ProviderState:
    name:           str     # "Provider/model"
    provider:       object  # g4f provider class
    model:          str
    max_concurrent: int = 1

    consec_failures: int   = field(default=0, repr=False)
    tripped_at:      float = field(default=0.0, repr=False)
    total_ok:        int   = field(default=0, repr=False)
    total_fail:      int   = field(default=0, repr=False)

    # Semaphore is created after the event loop starts (see startup handler)
    semaphore: Optional[asyncio.Semaphore] = field(default=None, repr=False)

    # ── circuit ───────────────────────────────────────────────────────────────

    def is_healthy(self) -> bool:
        if self.tripped_at == 0.0:
            return True
        if time.time() - self.tripped_at >= RESET_AFTER_SEC:
            self._reset(f"auto-reset after {RESET_AFTER_SEC:.0f}s")
            return True
        return False

    def seconds_until_reset(self) -> float:
        if self.tripped_at == 0.0:
            return 0.0
        return max(0.0, RESET_AFTER_SEC - (time.time() - self.tripped_at))

    def record_success(self) -> None:
        if self.consec_failures:
            logger.info(f"[CB] ✅ {self.name} recovered")
        self.consec_failures = 0
        self.tripped_at = 0.0
        self.total_ok += 1

    def record_failure(self) -> None:
        self.total_fail += 1
        self.consec_failures += 1
        if self.consec_failures >= FAILURE_THRESHOLD and self.tripped_at == 0.0:
            self.tripped_at = time.time()
            logger.warning(
                f"[CB] ⚡ OPEN  {self.name}  "
                f"({self.consec_failures} failures — paused {RESET_AFTER_SEC:.0f}s)"
            )

    def _reset(self, reason: str = "") -> None:
        logger.info(f"[CB] 🔄 RESET {self.name}  ({reason})")
        self.consec_failures = 0
        self.tripped_at = 0.0

    # ── semaphore helpers ─────────────────────────────────────────────────────

    def active_count(self) -> int:
        """How many requests are currently using this provider."""
        if self.semaphore is None:
            return 0
        return self.max_concurrent - self.semaphore._value  # type: ignore[attr-defined]

    def try_acquire_nowait(self) -> bool:
        """Non-blocking acquire. Returns True if we got the slot."""
        if self.semaphore is None:
            return True
        return self.semaphore._value > 0  # type: ignore[attr-defined]


def _parse_providers() -> List[ProviderState]:
    states: List[ProviderState] = []
    for entry in G4F_PROVIDERS_RAW.split(","):
        entry = entry.strip()
        if not entry:
            continue
        parts = entry.split(":")
        pname = parts[0].strip()
        mname = parts[1].strip() if len(parts) > 1 else "gpt-4o-mini"
        mconc = int(parts[2].strip()) if len(parts) > 2 else 1

        cls = getattr(Providers, pname, None)
        if cls is None:
            logger.warning(f"[G4F] Unknown provider '{pname}' — skipped")
            continue
        states.append(ProviderState(
            name=f"{pname}/{mname}",
            provider=cls,
            model=mname,
            max_concurrent=mconc,
        ))

    if not states:
        logger.error("[G4F] No valid providers! Check G4F_PROVIDERS env var.")
    return states


PROVIDER_STATES: List[ProviderState] = _parse_providers()

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="G4F Bridge", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_client = AsyncClient()


@app.on_event("startup")
async def startup() -> None:
    """Initialize asyncio.Semaphores inside the running event loop."""
    for state in PROVIDER_STATES:
        state.semaphore = asyncio.Semaphore(state.max_concurrent)
    logger.info(
        "[G4F] Providers: %s",
        ", ".join(f"{s.name} (max={s.max_concurrent})" for s in PROVIDER_STATES),
    )
    logger.info(
        "[G4F] Circuit breaker: trip after %d failures, reset after %gs",
        FAILURE_THRESHOLD, RESET_AFTER_SEC,
    )


# ─── Schemas ──────────────────────────────────────────────────────────────────

class Message(BaseModel):
    role:    str
    content: str

class ChatRequest(BaseModel):
    model:       Optional[str]   = None
    messages:    List[Message]
    temperature: Optional[float] = 0.7
    max_tokens:  Optional[int]   = 2048
    web_search:  Optional[bool]  = False

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _is_auth_error(msg: str) -> bool:
    low = msg.lower()
    return any(k in low for k in ("api_key", "api key", "apikey", "unauthorized", "401"))


def _ordered_providers() -> List[ProviderState]:
    """Healthy providers first, tripped ones last (emergency fallback)."""
    healthy = [s for s in PROVIDER_STATES if s.is_healthy()]
    tripped = [s for s in PROVIDER_STATES if not s.is_healthy()]
    return healthy + tripped

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/status")
async def status():
    return {
        "providers": [
            {
                "name":                s.name,
                "healthy":             s.is_healthy(),
                "max_concurrent":      s.max_concurrent,
                "active_now":          s.active_count(),
                "consecutive_failures": s.consec_failures,
                "total_ok":            s.total_ok,
                "total_fail":          s.total_fail,
                "resets_in_sec":       round(s.seconds_until_reset()),
            }
            for s in PROVIDER_STATES
        ],
        "config": {
            "failure_threshold": FAILURE_THRESHOLD,
            "reset_after_sec":   RESET_AFTER_SEC,
            "max_retries":       MAX_RETRIES,
            "call_timeout_sec":  CALL_TIMEOUT,
        },
    }


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data":   [{"id": s.model, "object": "model"} for s in PROVIDER_STATES],
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatRequest):
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    ordered  = _ordered_providers()

    if not ordered:
        raise HTTPException(status_code=503, detail="No providers configured")

    last_error   = "unknown"
    tried_healthy = False

    for state in ordered:
        healthy = state.is_healthy()
        if not healthy and tried_healthy:
            continue   # skip tripped if healthy ones exist
        if healthy:
            tried_healthy = True

        sem = state.semaphore
        if sem is None:
            continue

        # ── Non-blocking semaphore check ──────────────────────────────────────
        # If this provider is already at max concurrent requests, skip it NOW
        # (instead of queuing and getting a 429 from the real API).
        # We'll come back to it as a fallback after all others are tried.
        slot_available = sem._value > 0  # type: ignore[attr-defined]
        if not slot_available:
            logger.info(f"[G4F] {state.name} busy (max={state.max_concurrent}) — skipping")
            continue

        await sem.acquire()
        request_failed = True

        try:
            for attempt in range(1, MAX_RETRIES + 1):
                try:
                    logger.info(f"[G4F] ▶ {state.name}  attempt {attempt}/{MAX_RETRIES}")

                    response = await asyncio.wait_for(
                        _client.chat.completions.create(
                            model=state.model,
                            messages=messages,
                            provider=state.provider,
                            web_search=req.web_search or False,
                        ),
                        timeout=CALL_TIMEOUT,
                    )

                    content = response.choices[0].message.content
                    if not content:
                        raise ValueError("empty response")

                    state.record_success()
                    request_failed = False
                    logger.info(f"[G4F] ✓ {state.name} — {len(content)} chars")

                    return {
                        "id":      "chatcmpl-g4f",
                        "object":  "chat.completion",
                        "model":   state.model,
                        "choices": [{
                            "index":         0,
                            "message":       {"role": "assistant", "content": content},
                            "finish_reason": "stop",
                        }],
                        "usage": {
                            "prompt_tokens":     0,
                            "completion_tokens": 0,
                            "total_tokens":      0,
                        },
                    }

                except asyncio.TimeoutError:
                    last_error = f"timeout ({CALL_TIMEOUT:.0f}s)"
                    logger.warning(f"[G4F] ⏰ {state.name} timed out")
                    break

                except Exception as exc:
                    last_error = str(exc)
                    if _is_auth_error(last_error):
                        logger.warning(f"[G4F] 🔒 {state.name} auth error — tripping")
                        state.tripped_at      = time.time()
                        state.consec_failures = FAILURE_THRESHOLD
                        break
                    logger.warning(f"[G4F] ✗ {state.name} attempt {attempt}: {last_error[:120]}")
                    if attempt < MAX_RETRIES:
                        await asyncio.sleep(2 ** (attempt - 1))
        finally:
            sem.release()

        if request_failed:
            state.record_failure()

    # ── All healthy providers were either busy or failed ──────────────────────
    # Last resort: wait for the first available provider (blocking acquire)
    logger.warning("[G4F] All providers busy/failed — waiting for first available slot")
    for state in [s for s in PROVIDER_STATES if s.is_healthy() and s.semaphore]:
        sem = state.semaphore
        assert sem is not None
        await sem.acquire()
        try:
            logger.info(f"[G4F] ▶ {state.name}  (queued fallback)")
            response = await asyncio.wait_for(
                _client.chat.completions.create(
                    model=state.model,
                    messages=messages,
                    provider=state.provider,
                    web_search=req.web_search or False,
                ),
                timeout=CALL_TIMEOUT,
            )
            content = response.choices[0].message.content
            if not content:
                raise ValueError("empty response")
            state.record_success()
            logger.info(f"[G4F] ✓ {state.name} (queued) — {len(content)} chars")
            return {
                "id":      "chatcmpl-g4f",
                "object":  "chat.completion",
                "model":   state.model,
                "choices": [{
                    "index":         0,
                    "message":       {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
        except Exception as exc:
            last_error = str(exc)
            state.record_failure()
            logger.warning(f"[G4F] ✗ {state.name} queued fallback failed: {last_error[:120]}")
        finally:
            sem.release()

    raise HTTPException(
        status_code=502,
        detail=f"All providers failed. Last error: {last_error}. Check GET /status",
    )


# ─── Dev entrypoint ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")
