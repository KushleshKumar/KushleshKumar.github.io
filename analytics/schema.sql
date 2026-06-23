-- D1 (SQLite) schema for the site visitor tracker.
-- Apply remotely:
--   npx wrangler d1 execute site_analytics --remote --file analytics/schema.sql

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,          -- server receive time, epoch ms (authoritative)
  type         TEXT    NOT NULL,          -- pageview | click | outbound | download | scroll | ping

  -- visitor / session identity (first-party, set by the browser)
  visitor_id   TEXT,                      -- stable per browser (localStorage UUID)
  session_id   TEXT,                      -- per tab/session (sessionStorage UUID)
  visit_no     INTEGER,                   -- which visit for this visitor (1 = first ever)

  -- page
  url          TEXT,
  path         TEXT,
  hash         TEXT,
  title        TEXT,
  referrer     TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,

  -- event detail (clicks / scroll / engagement)
  target       TEXT,                      -- clicked link href or element identifier
  target_text  TEXT,                      -- visible text of the clicked element
  value        REAL,                      -- pageview=visit #, scroll=percent, ping=active seconds

  -- network + geo (filled server-side from the Cloudflare edge)
  ip           TEXT,
  country      TEXT,
  region       TEXT,
  city         TEXT,
  postal       TEXT,
  latitude     TEXT,
  longitude    TEXT,
  geo_tz       TEXT,
  asn          INTEGER,
  isp          TEXT,                       -- request.cf.asOrganization

  -- client environment
  ua           TEXT,
  browser      TEXT,
  os           TEXT,
  device       TEXT,                       -- mobile | tablet | desktop
  is_bot       INTEGER,                    -- 1 if the user-agent looks like a bot/crawler
  screen_w     INTEGER,
  screen_h     INTEGER,
  viewport_w   INTEGER,
  viewport_h   INTEGER,
  lang         TEXT,
  client_tz    TEXT,
  color_scheme TEXT,                       -- light | dark
  connection   TEXT,                       -- 4g | wifi | ...
  load_ms      INTEGER                     -- page load time (ms)
);

CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_events_country ON events(country);
CREATE INDEX IF NOT EXISTS idx_events_path    ON events(path);
