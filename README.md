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

## Ports

| Service | Host port | Container port |
|---|---|---|
| Web UI | `3001` | `3000` |
| PostgreSQL | `5438` | `5432` |
