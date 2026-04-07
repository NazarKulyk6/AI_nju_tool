# AI Analysis Flow — Покрокова документація

## Архітектура (загальна схема)

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (UI)                            │
│          http://localhost:3001/analyzer                     │
└────────────────────┬────────────────────────────────────────┘
                     │ POST /api/analyze-all
                     │ GET  /api/analyze-status
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Node.js  (njuskalo_web :3000)                  │
│   src/server.ts  +  src/ai_analyzer.ts                      │
│                                                             │
│  1. Зчитує необроблені listings з PostgreSQL                │
│  2. Формує prompt для кожного                               │
│  3. Викликає AI бекенд                                      │
│  4. Парсить JSON відповідь                                  │
│  5. Зберігає analyzed_items у PostgreSQL                    │
└────────────────────┬────────────────────────────────────────┘
                     │ (якщо AI_BACKEND=g4f)
                     │ POST http://g4f:8080/v1/chat/completions
                     ▼
┌─────────────────────────────────────────────────────────────┐
│           G4F Bridge  (njuskalo_g4f :8080)                  │
│   g4f_bridge/main.py  (FastAPI + Python)                    │
│                                                             │
│  Circuit breaker → вибирає здорового провайдера             │
│  Провайдер 1: PollinationsAI / openai-fast                  │
│  Провайдер 2: Yqcloud / gpt-4          (fallback)           │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP → зовнішній AI провайдер
                     ▼
            [PollinationsAI API] або [Yqcloud API]
            (безкоштовно, без API ключа)
```

---

## Крок 1 — Користувач запускає аналіз (UI)

Сторінка: `http://localhost:3001/analyzer`

Користувач натискає кнопку **"Run AI Analysis"**.  
Браузер відправляє:
```
POST /api/analyze-all
```
Node.js стартує фонове завдання (`analyzeJob`) і одразу повертає `{ started: true }`.  
Браузер кожні 1.5 секунди опитує:
```
GET /api/analyze-status
```
і відображає прогрес: `done / total`, поточний listing, статус `running → done`.

---

## Крок 2 — Node.js вибирає необроблені listings

**Файл:** `src/ai_analyzer.ts` → функція `getUnprocessedListings()`

SQL запит:
```sql
SELECT id, url, title, price, info, description, category
  FROM listings
 WHERE processed = FALSE
 ORDER BY id ASC
```

Повертає всі рядки де `processed = false` (ще не аналізувались).

---

## Крок 3 — Формується prompt для кожного listing

**Файл:** `src/ai_analyzer.ts` → функція `buildUserContent()`

З кожного рядка формується текст:
```
Title: <назва оголошення>
Price: <ціна або N/A>
Info: <технічні характеристики або N/A>
Description: <опис або N/A>
Category hint: <категорія з сайту або N/A>
```

Цей текст додається до великого **системного prompt** (`AI_SYSTEM_PROMPT`) який:
- описує задачу: класифікувати товар, витягти структуровані дані
- задає повну ієрархію категорій (12 категорій → 60+ підкатегорій → 130+ типів)
- вимагає відповідь суворо у форматі JSON без пояснень

---

## Крок 4 — Вибір AI бекенду

**Файл:** `src/ai_analyzer.ts` → функція `analyzeWithAI()`

```
AI_BACKEND=g4f    → callG4F()     (безкоштовно)
AI_BACKEND=gemini → callGemini()  (потрібен GEMINI_API_KEY)
```

Визначається через змінну оточення `AI_BACKEND` з `.env`.

---

## Крок 5а — Виклик G4F бекенду

**Файл:** `src/ai_analyzer.ts` → функція `callG4F()`

Node.js відправляє HTTP запит до G4F Bridge:
```
POST http://g4f:8080/v1/chat/completions
Content-Type: application/json

{
  "model": "openai-fast",
  "messages": [
    { "role": "system", "content": "<великий системний prompt>" },
    { "role": "user",   "content": "Title: ...\nPrice: ...\nInfo: ..." }
  ],
  "temperature": 0.2,
  "max_tokens": 1024
}
```

> `temperature: 0.2` — дуже детерміністична відповідь (менше "фантазії" у класифікації).

---

## Крок 5б — G4F Bridge обробляє запит (circuit breaker)

**Файл:** `g4f_bridge/main.py`

### 5б.1 — Вибір провайдера

Bridge будує список здорових провайдерів:
```
[PollinationsAI/openai-fast, Yqcloud/gpt-4]
  ↑ healthy first              ↑ tripped ones last
```

### 5б.2 — Спроба виклику

Для кожного провайдера (по порядку):

```python
response = await asyncio.wait_for(
    g4f_client.chat.completions.create(
        model="openai-fast",
        messages=[...],
        provider=PollinationsAI,
    ),
    timeout=60  # секунд
)
```

### 5б.3 — Обробка результату

| Результат | Дія |
|---|---|
| ✅ Успіх, є текст | Повернути відповідь, `record_success()` |
| ⏰ Timeout (60s) | Пропустити провайдера, перейти до наступного |
| 🔒 Помилка авторизації | Негайно замкнути circuit, перейти до наступного |
| ❌ Інша помилка | Retry (до 2 разів з паузою 1s/2s), потім `record_failure()` |

### 5б.4 — Circuit Breaker

Якщо провайдер `record_failure()` викликається **3 рази поспіль** (`G4F_FAILURE_THRESHOLD=3`):

```
⚡ Circuit OPEN: PollinationsAI/openai-fast
   Paused for 300 seconds
```

Після 300 секунд (`G4F_RESET_AFTER_SEC=300`) — автоматичне відновлення.

**Стан circuit breaker** можна перевірити:
```
GET http://localhost:1337/status
```

### 5б.5 — Fallback

Якщо PollinationsAI не відповів → Bridge автоматично пробує `Yqcloud/gpt-4`.  
Якщо всі провайдери впали → повертає HTTP 502.

---

## Крок 5в — Виклик Gemini бекенду (альтернатива)

**Файл:** `src/ai_analyzer.ts` → функція `callGemini()`

Перебирає моделі по черзі:
```
gemma-3-27b-it → gemma-3-12b-it → gemini-3.1-flash-lite-preview → gemini-2.5-flash
```

Логіка переходу між моделями:
| HTTP статус | Деталь | Дія |
|---|---|---|
| `429` + `"limit: 0"` | Квота вичерпана назавжди | Перейти до наступної моделі |
| `429` без `limit: 0` | Тимчасовий rate limit | Exponential back-off: 2s → 4s → 8s → 16s, потім retry |
| Інша помилка | HTTP error | Кинути виняток |

---

## Крок 6 — Парсинг JSON відповіді

**Файл:** `src/ai_analyzer.ts` → функція `extractItems()`

AI повертає текст виду:
```json
{
  "items": [
    {
      "category": "electronics",
      "subcategory": "computers",
      "type": "laptop",
      "title": "MacBook Pro 16 M3",
      "price": 2500,
      "ram_gb": 16,
      "storage_gb": 512,
      "cpu": "Apple M3 Pro"
    }
  ]
}
```

Функція `extractItems()`:
1. Видаляє markdown-огорожі (` ```json `) якщо AI додав їх
2. Парсить JSON через `JSON.parse()`
3. Перевіряє наявність поля `items[]`
4. Повертає масив `AnalyzedItem[]`

---

## Крок 7 — Збереження в базу даних

**Файл:** `src/ai_analyzer.ts` → функція `saveAnalyzedItems()`

Для кожного item з масиву виконується INSERT:
```sql
INSERT INTO analyzed_items
  (listing_id, category, subcategory, type, title, price,
   capacity_gb, ram_gb, cpu, storage_gb, raw)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
```

> Поле `raw` (повна JSON відповідь AI) зберігається лише для першого item з listing.

---

## Крок 8 — Позначення listing як оброблений

**Файл:** `src/ai_analyzer.ts` → функція `markListingProcessed()`

```sql
UPDATE listings SET processed = TRUE WHERE id = $1
```

Після цього listing більше не потрапляє у вибірку при наступному запуску.

---

## Крок 9 — Пауза між запитами

Між кожним listing Node.js чекає:
```
AI_CALL_DELAY_MS=2200  (мілісекунди)
```

Це запобігає rate limiting з боку AI провайдерів.

---

## Повний timeline одного listing

```
t=0ms    Зчитати listing з PostgreSQL
t=5ms    Сформувати prompt (system + user content)
t=10ms   POST → g4f:8080/v1/chat/completions
t=10ms   G4F Bridge: circuit breaker вибирає PollinationsAI
t=10ms   G4F Bridge → POST → text.pollinations.ai
t=~3000ms  PollinationsAI повертає JSON
t=~3005ms  G4F Bridge перевіряє відповідь → 200 OK
t=~3010ms  Node.js отримує відповідь
t=~3015ms  extractItems() парсить JSON
t=~3020ms  saveAnalyzedItems() → INSERT до analyzed_items
t=~3025ms  markListingProcessed() → UPDATE listings
t=~3025ms  Лог: ✓ Saved N item(s) for listing #ID
t=5225ms   sleep(AI_CALL_DELAY_MS=2200ms)
t=5225ms   Перехід до наступного listing
```

---

## Що де шукати при проблемах

| Симптом | Де дивитись |
|---|---|
| AI не відповідає | `docker logs njuskalo_g4f` |
| Circuit tripped | `curl http://localhost:1337/status` |
| Listings не аналізуються | `docker logs njuskalo_web` |
| Помилка парсингу JSON | Лог `[AI/G4F] returned invalid JSON:` в `njuskalo_web` |
| Rate limit Gemini | Лог `[AI/Gemini] 429 on ...` в `njuskalo_web` |
| Провайдер не знайдений | Лог `Unknown provider '...' — skipped` в `njuskalo_g4f` |

---

## Змінні оточення що впливають на аналіз

| Змінна | Дефолт | Опис |
|---|---|---|
| `AI_BACKEND` | `g4f` | `g4f` або `gemini` |
| `AI_CALL_DELAY_MS` | `2200` | Пауза між listings (мс) |
| `G4F_BASE_URL` | `http://g4f:8080/v1` | URL g4f bridge |
| `G4F_PROVIDERS` | `PollinationsAI:openai-fast,Yqcloud:gpt-4` | Провайдери з моделями |
| `G4F_FAILURE_THRESHOLD` | `3` | Провалів до trip circuit |
| `G4F_RESET_AFTER_SEC` | `300` | Секунд до авто-відновлення |
| `G4F_CALL_TIMEOUT` | `60` | Timeout одного виклику (с) |
| `G4F_MAX_RETRIES` | `2` | Retry спроб per провайдер |
| `GEMINI_API_KEY` | — | Ключ для Gemini бекенду |
| `GEMINI_ANALYZER_MODELS` | `gemma-3-27b-it,...` | Моделі для аналізу |
| `GEMINI_RETRY_ATTEMPTS` | `4` | Retry на 429 помилку |
