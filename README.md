# Njuskalo Scraper

A production-ready web scraper for [njuskalo.hr](https://www.njuskalo.hr/) built with Node.js, TypeScript, Playwright, PostgreSQL, and Docker.

## Features

- 🔍 **Search-driven scraping** — enter any keyword and scrape all matching listings
- 📄 **Page-by-page processing** — listings are saved to the database as each results page is scraped
- 🧠 **Anti-detection** — random delays, human-like scrolling, rotating User-Agents, masked `navigator.webdriver`
- 🗃️ **PostgreSQL storage** — deduplication via `ON CONFLICT (url)`
- 🏷️ **Categories** — tag scraped listings with a custom category for easy filtering
- 🌐 **Web UI** — search, filter by category, and browse all scraped listings
- 🖥️ **Scraper control panel** — trigger scraping jobs directly from the browser with a live timer
- 🐳 **Fully containerised** — Docker Compose manages the database, web server, and scraper

## Stack

| Layer | Technology |
|---|---|
| Scraper | [Playwright](https://playwright.dev/) (Chromium, non-headless via Xvfb) |
| Backend | Node.js 20 + TypeScript + Express |
| Database | PostgreSQL 16 |
| Frontend | Vanilla HTML/CSS/JS (SPA) |
| Container | Docker + Docker Compose |

## Project Structure

```
├── src/
│   ├── db.ts          # Database connection, schema, insert logic
│   ├── scraper.ts     # Core Playwright scraping pipeline
│   ├── server.ts      # Express API + static file server
│   ├── utils.ts       # Delays, scrolling, retry, URL helpers
│   └── index.ts       # CLI entry point
├── public/
│   └── index.html     # Single-page frontend
├── Dockerfile         # Multi-stage build (builder / runtime / web)
├── docker-compose.yml # Services: db, web, scraper
└── env.example        # Environment variable template
```

## Scraped Data

Each listing stores the following fields:

| Field | Description |
|---|---|
| `url` | Original listing URL (unique) |
| `title` | Listing title |
| `price` | Price as displayed on the page |
| `info` | Raw text from the "Basic Info" block |
| `description` | Raw text from the "Description" block |
| `category` | User-defined category tag |
| `created_at` | Timestamp of insertion |

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/install/)
- [Git](https://git-scm.com/)

### 1. Clone the repository

```bash
git clone git@github.com:NazarKulyk6/AI_nju_tool.git
cd AI_nju_tool
```

### 2. Configure environment

```bash
cp env.example .env
```

Edit `.env` if you want to change credentials (defaults work out of the box).

### 3. Build and start

```bash
docker compose up -d --build
```

This starts **PostgreSQL** and the **web server**. The first build takes ~3–5 minutes (downloads the Playwright image).

### 4. Open the web UI

```
http://localhost:3001
```

### 5. Run a scrape job

**Option A — from the browser:**
Click the **Scrape** button in the top-right corner, enter a search query and optional category, then click **Start**.

**Option B — from the terminal (CLI):**
```bash
docker compose run --rm scraper
```
You will be prompted to enter a search query.

### Useful commands

```bash
# View logs
docker compose logs -f web

# Stop everything
docker compose down

# Stop and delete database volume (wipes all scraped data)
docker compose down -v
```

## How It Works

For a detailed step-by-step explanation of the scraping process, query generation, stages, and storage rules see **[HOW_IT_WORKS.md](./HOW_IT_WORKS.md)**.

## Ports

| Service | Host port | Container port |
|---|---|---|
| Web UI | `3001` | `3000` |
| PostgreSQL | `5438` | `5432` |
