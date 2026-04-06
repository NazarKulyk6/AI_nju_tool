# How the Scraper Works — Step-by-Step Guide

## Pages

| URL | What's there |
|---|---|
| `http://localhost:3001` | Browse and search collected listings |
| `http://localhost:3001/scraper` | Scraper control panel |

---

## Step 1 — Build your query list

Open **http://localhost:3001/scraper**.

There are two ways to add queries:

### A) Via AI (recommended)

1. Type what you're looking for in the "What do you want to find?" field — in any language  
   _(e.g. `graphics card 2060`, `iPhone 14`, `electric scooter`)_
2. Click **✨ Generate with AI**
3. Gemini returns 10–20 variants in Croatian and English — exactly how sellers write on njuskalo.hr
4. All variants appear as chips, all selected by default
5. Deselect the ones you don't need, or add your own manually

### B) Manually (without AI)

1. Type a query in the **"Type a search query…"** field
2. Press **Add** or Enter — it appears as a chip
3. Repeat for each additional query

Both approaches can be combined. AI-generated queries are **merged** with any chips you've already added — no duplicates, nothing gets removed.

---

## Step 2 — Set a category (optional)

Type a category name in the **Category** field _(e.g. `GPU`, `Phones`, `Cars`)_.

- Autocomplete shows categories already present in the database
- The category is applied to **every** query in this job
- The same listing can be saved under different categories as separate rows
- Within one category there will be **no duplicates** — if a URL is already saved in that category it will be skipped (without re-parsing)

---

## Step 3 — Start scraping

Click **▶ Start Scraping**. The scraper runs in two stages:

### Stage 1 — Collecting links

- Opens search result pages on njuskalo.hr for each query one by one
- Goes through **all** pagination pages with no limit
- Saves every found URL directly to the `pending_urls` table in PostgreSQL (not in process memory)
- After pagination finishes, runs a SQL query: selects only URLs from `pending_urls` that do **not** yet exist in `listings` for this category → the rest are marked as *skipped* (will not be parsed again)
- After the entire job completes, `pending_urls` rows are automatically deleted

### Stage 2 — Parsing listings

- Visits each new URL one by one
- Extracts: title, price, "Osnovne informacije" block, "Opis oglasa" block
- Saves to PostgreSQL immediately
- Progress bar shows `collected / total` in real time

### What is displayed during the run

| Element | What it shows |
|---|---|
| Stage 1 / Stage 2 pills | Which stage is currently active |
| `query 2 / 5` | Which query from the list is being processed |
| `found 45, skipped 12` | How many URLs were found and how many were skipped |
| Progress bar | How many listings have been processed out of new ones |
| Timer | How much time has elapsed |

---

## Step 4 — View results

Go to **http://localhost:3001**:

- Search by title, description, and info block
- Filter by category
- Sorted by date (newest first)

---

## Storage rules

```
Same URL + same category  →  skip (duplicate)
Same URL + different category  →  save (new row)
New URL  →  always save
```

---

## What is stored for each listing

| Field | Contains |
|---|---|
| `url` | Link to the listing |
| `title` | Listing title |
| `price` | Price as displayed on the page |
| `info` | Full text of the "Osnovne informacije" block |
| `description` | Full text of the "Opis oglasa" block |
| `category` | Category set at job start |
| `created_at` | Time the record was saved |
