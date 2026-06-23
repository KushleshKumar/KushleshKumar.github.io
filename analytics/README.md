# Visitor analytics (self-hosted)

A lightweight, **first-party** visitor tracker for this GitHub Pages site:

```
browser (tracker.js) ──beacon──▶ Cloudflare Worker ──▶ D1 (SQLite) ──▶ dashboard.html
                                   adds IP + geo at the edge          filter / sort / CSV
```

No third-party analytics, no client-side IP lookup. Cloudflare's free tier (100k
requests/day) covers a personal site many times over.

## Files

| File             | Runs on              | Purpose |
|------------------|----------------------|---------|
| `tracker.js`     | the public site      | sends pageviews, clicks, scroll depth, engagement time |
| `worker.js`      | Cloudflare           | `POST /collect` (write) and `GET /api/stats` (read, token-gated) |
| `schema.sql`     | D1                   | the `events` table |
| `wrangler.toml`  | —                    | Worker + D1 config |
| `dashboard.html` | open locally / host  | filter, sort, export CSV |

## One-time setup

All commands use `npx wrangler …` (or install once: `npm i -g wrangler`).

1. **Log in**
   ```bash
   npx wrangler login
   ```
2. **Create the database**, then paste the printed `database_id` into `wrangler.toml`:
   ```bash
   npx wrangler d1 create site_analytics
   ```
3. **Create the table** (`--remote` = the live D1, not a local copy):
   ```bash
   npx wrangler d1 execute site_analytics --remote --file analytics/schema.sql
   ```
4. **Set the dashboard token** (any strong secret string you'll paste into the dashboard):
   ```bash
   npx wrangler secret put DASH_TOKEN
   ```
5. **Deploy** (run inside `analytics/`, or add `-c analytics/wrangler.toml`):
   ```bash
   cd analytics && npx wrangler deploy
   ```
   Copy the deployed URL, e.g. `https://site-analytics.<you>.workers.dev`.

## Wire up the site

1. Put the Worker URL in **`tracker.js`** → `ENDPOINT` (no trailing slash).
2. The tracker is already included from `index.html`:
   ```html
   <script src="/analytics/tracker.js" defer></script>
   ```
   > ⚠️ `index.html` is a **generated bundle**. If you re-export the design, re-add
   > that one line (or add it to your design source before exporting).
3. Commit & push — GitHub Pages serves the script from `/analytics/tracker.js`.

## View stats

Open **`dashboard.html`** (double-clicking the file works — it talks to the Worker
over HTTPS). Paste the Worker URL + your `DASH_TOKEN`, click **Connect**. Filter by
date / type / country / path / free-text, click any column header to sort, and
**Export CSV** to download the filtered set.

## What gets captured

- **Server-side (edge, reliable):** IP, country / region / city, coarse lat-long,
  postal code, timezone, ISP / ASN, bot guess, authoritative timestamp.
- **Client-side:** path + hash, referrer + UTM, link / outbound / download clicks,
  scroll depth, active engagement seconds, new-vs-returning + visit count,
  screen / viewport / device, browser / OS, language, timezone, dark/light,
  connection type, page load time.
- The shared `value` column means: pageview → visit number · scroll → percent ·
  ping → active seconds.

## Privacy

IP + location are personal data under GDPR / UK ePrivacy. For a low-traffic personal
site this is usually low-risk, but if you expect EU/UK visitors and store raw IPs,
add a short privacy line to the site footer and consider truncating or hashing the IP
in `worker.js` (e.g. drop the last octet). The tracker uses first-party storage only —
no third-party cookies. To honour Do Not Track, you can early-return in `tracker.js`
when `navigator.doNotTrack === "1"`.
