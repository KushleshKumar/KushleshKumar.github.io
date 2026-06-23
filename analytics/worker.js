/**
 * site-analytics — Cloudflare Worker
 *
 * Routes:
 *   POST /collect     public; receives a beacon, enriches with edge IP/geo, stores a row
 *   GET  /api/stats   token-gated; returns filtered rows + summary (JSON, or CSV)
 *   GET  /            health check
 *
 * Bindings (see wrangler.toml):
 *   DB          D1 database
 *   DASH_TOKEN  secret string required to read /api/stats  (wrangler secret put DASH_TOKEN)
 */

// Columns written on every /collect, in order. Must match schema.sql.
const COLUMNS = [
  "ts", "type", "visitor_id", "session_id", "visit_no",
  "url", "path", "hash", "title", "referrer", "utm_source", "utm_medium", "utm_campaign",
  "target", "target_text", "value",
  "ip", "country", "region", "city", "postal", "latitude", "longitude", "geo_tz", "asn", "isp",
  "ua", "browser", "os", "device", "is_bot",
  "screen_w", "screen_h", "viewport_w", "viewport_h",
  "lang", "client_tz", "color_scheme", "connection", "load_ms",
];

// Columns allowed in ORDER BY (prevents SQL injection through the `order` param).
const SORTABLE = new Set([
  "id", "ts", "type", "country", "city", "path", "visitor_id",
  "isp", "device", "browser", "os", "value", "load_ms",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return preflight();

    if (url.pathname === "/collect" && request.method === "POST") {
      return collect(request, env);
    }
    if (url.pathname === "/api/stats" && request.method === "GET") {
      return stats(request, env, url);
    }
    if (url.pathname === "/") {
      return new Response("site-analytics worker is running.", {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// POST /collect
// ---------------------------------------------------------------------------
async function collect(request, env) {
  let body = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch (_) {
    // Ignore malformed payloads; still record what the edge knows below.
  }

  const cf = request.cf || {};
  const ua = request.headers.get("user-agent") || "";
  const env_ = parseUA(ua);

  const row = {
    ts: Date.now(),
    type: str(body.type) || "pageview",
    visitor_id: str(body.visitor_id),
    session_id: str(body.session_id),
    visit_no: int(body.visit_no),
    url: str(body.url),
    path: str(body.path),
    hash: str(body.hash),
    title: str(body.title),
    referrer: str(body.referrer),
    utm_source: str(body.utm_source),
    utm_medium: str(body.utm_medium),
    utm_campaign: str(body.utm_campaign),
    target: str(body.target),
    target_text: str(body.target_text),
    value: num(body.value),
    // ---- server-side, from the Cloudflare edge ----
    ip: request.headers.get("cf-connecting-ip") || "",
    country: str(cf.country),
    region: str(cf.region),
    city: str(cf.city),
    postal: str(cf.postalCode),
    latitude: str(cf.latitude),
    longitude: str(cf.longitude),
    geo_tz: str(cf.timezone),
    asn: int(cf.asn),
    isp: str(cf.asOrganization),
    ua,
    browser: env_.browser,
    os: env_.os,
    device: env_.device,
    is_bot: env_.bot ? 1 : 0,
    // ---- client-reported ----
    screen_w: int(body.screen_w),
    screen_h: int(body.screen_h),
    viewport_w: int(body.viewport_w),
    viewport_h: int(body.viewport_h),
    lang: str(body.lang),
    client_tz: str(body.client_tz),
    color_scheme: str(body.color_scheme),
    connection: str(body.connection),
    load_ms: int(body.load_ms),
  };

  const placeholders = COLUMNS.map(() => "?").join(",");
  const values = COLUMNS.map((c) => (row[c] === undefined ? null : row[c]));
  try {
    await env.DB.prepare(
      `INSERT INTO events (${COLUMNS.join(",")}) VALUES (${placeholders})`
    ).bind(...values).run();
  } catch (e) {
    return cors(new Response("db error: " + e.message, { status: 500 }));
  }
  return cors(new Response(null, { status: 204 }));
}

// ---------------------------------------------------------------------------
// GET /api/stats
// ---------------------------------------------------------------------------
async function stats(request, env, url) {
  // Authorised by EITHER a valid Cloudflare Access SSO login (Google — nothing to
  // remember) OR the DASH_TOKEN (local dashboard / scripts / CSV download links).
  const token = url.searchParams.get("token") || bearer(request);
  const tokenOk = !!env.DASH_TOKEN && token === env.DASH_TOKEN;
  if (!tokenOk && !(await accessOk(request, env))) {
    return cors(new Response("Unauthorized", { status: 401 }));
  }

  const q = url.searchParams;
  const where = [];
  const binds = [];

  const from = parseTime(q.get("from"));
  if (from != null) { where.push("ts >= ?"); binds.push(from); }
  const to = parseTime(q.get("to"));
  if (to != null) { where.push("ts <= ?"); binds.push(to); }
  if (q.get("type")) { where.push("type = ?"); binds.push(q.get("type")); }
  if (q.get("country")) { where.push("country = ?"); binds.push(q.get("country")); }
  if (q.get("visitor")) { where.push("visitor_id = ?"); binds.push(q.get("visitor")); }
  if (q.get("path")) { where.push("path LIKE ?"); binds.push("%" + q.get("path") + "%"); }
  if (q.get("q")) {
    const s = "%" + q.get("q") + "%";
    where.push("(city LIKE ? OR isp LIKE ? OR ip LIKE ? OR referrer LIKE ? OR target LIKE ? OR ua LIKE ?)");
    binds.push(s, s, s, s, s, s);
  }
  if (q.get("bots") !== "include") where.push("is_bot = 0");

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const andType = (t) => (whereSql ? whereSql + " AND " : "WHERE ") + t;

  let order = q.get("order");
  if (!SORTABLE.has(order)) order = "ts";
  const dir = (q.get("dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const limit = clampInt(q.get("limit"), 200, 1, 5000);
  const offset = clampInt(q.get("offset"), 0, 0, 1e9);

  const rows = (await env.DB.prepare(
    `SELECT * FROM events ${whereSql} ORDER BY ${order} ${dir} LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all()).results || [];

  // CSV export of the filtered set (respects all filters, capped at `limit`).
  if (q.get("format") === "csv") {
    return cors(new Response(toCSV(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="visits-${Date.now()}.csv"`,
      },
    }));
  }

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COUNT(DISTINCT visitor_id) AS uv,
            SUM(CASE WHEN type='pageview' THEN 1 ELSE 0 END) AS pv
     FROM events ${whereSql}`
  ).bind(...binds).first();

  const topCountries = (await env.DB.prepare(
    `SELECT country AS k, COUNT(*) AS n FROM events ${whereSql} GROUP BY country ORDER BY n DESC LIMIT 8`
  ).bind(...binds).all()).results;

  const topPaths = (await env.DB.prepare(
    `SELECT path AS k, COUNT(*) AS n FROM events ${andType("type='pageview'")} GROUP BY path ORDER BY n DESC LIMIT 8`
  ).bind(...binds).all()).results;

  const topReferrers = (await env.DB.prepare(
    `SELECT referrer AS k, COUNT(*) AS n FROM events ${andType("referrer <> ''")} GROUP BY referrer ORDER BY n DESC LIMIT 8`
  ).bind(...binds).all()).results;

  const topLinks = (await env.DB.prepare(
    `SELECT target AS k, COUNT(*) AS n FROM events ${andType("type IN ('click','outbound','download') AND target <> ''")} GROUP BY target ORDER BY n DESC LIMIT 10`
  ).bind(...binds).all()).results;

  return cors(json({
    total: totals?.n || 0,
    uniqueVisitors: totals?.uv || 0,
    pageviews: totals?.pv || 0,
    returned: rows.length,
    limit, offset,
    summary: { topCountries, topPaths, topReferrers, topLinks },
    rows,
  }));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const str = (v) => (v == null || v === "" ? null : String(v).slice(0, 2048));
const int = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return isNaN(n) ? null : n; };

function parseTime(v) {
  if (!v) return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function bearer(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

// ---- Cloudflare Access (Zero Trust SSO) -----------------------------------
// With ACCESS_TEAM_DOMAIN + ACCESS_AUD set (see wrangler.toml), the dashboard is
// reached through a Google login enforced by Cloudflare Access, which signs a
// short-lived JWT into every request. We verify that JWT here so no static token
// is needed. Until those vars are set this returns false and DASH_TOKEN is used.
let _jwks = { team: "", keys: null, exp: 0 };

async function accessOk(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud) return false;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || cookie(request, "CF_Authorization");
  if (!jwt) return false;
  try { return !!(await verifyAccessJwt(jwt, team, aud)); }
  catch (_) { return false; }
}

async function accessKeys(team) {
  const now = Date.now();
  if (_jwks.team === team && _jwks.keys && _jwks.exp > now) return _jwks.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const data = await res.json();
  _jwks = { team, keys: data.keys || [], exp: now + 3600000 }; // cache 1h
  return _jwks.keys;
}

async function verifyAccessJwt(token, team, aud) {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  const header = JSON.parse(b64urlStr(h));
  if (header.alg !== "RS256") return null;
  const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`)
  );
  if (!ok) return null;
  const claims = JSON.parse(b64urlStr(p));
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) return null;
  if (claims.iss && claims.iss !== `https://${team}`) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;
  return claims;
}

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlStr(s) { return new TextDecoder().decode(b64urlBytes(s)); }
function cookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}
function parseUA(ua) {
  const u = ua.toLowerCase();
  const bot = /bot|crawl|spider|slurp|bing|google|baidu|yandex|duckduck|facebookexternal|embedly|preview|monitor|curl|wget|python-requests|headless|lighthouse|pingdom|uptime/.test(u);
  let browser = "Other";
  if (u.includes("edg/")) browser = "Edge";
  else if (u.includes("opr/") || u.includes(" opera")) browser = "Opera";
  else if (u.includes("chrome/") && !u.includes("chromium")) browser = "Chrome";
  else if (u.includes("firefox/")) browser = "Firefox";
  else if (u.includes("safari/") && !u.includes("chrome")) browser = "Safari";
  let os = "Other";
  if (u.includes("windows")) os = "Windows";
  else if (u.includes("android")) os = "Android";
  else if (u.includes("iphone") || u.includes("ipad") || u.includes("ios")) os = "iOS";
  else if (u.includes("mac os")) os = "macOS";
  else if (u.includes("linux")) os = "Linux";
  let device = "desktop";
  if (u.includes("ipad") || (u.includes("android") && !u.includes("mobile"))) device = "tablet";
  else if (u.includes("mobi") || u.includes("iphone") || u.includes("android")) device = "mobile";
  return { browser, os, device, bot };
}
function toCSV(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [cols.join(",")];
  for (const r of rows) out.push(cols.map((c) => esc(r[c])).join(","));
  return out.join("\n");
}

// CORS: /api/stats is token-gated and /collect is public by design, so an
// open ACAO is fine and lets the dashboard run from file:// or any host.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "access-control-max-age": "86400",
};
function preflight() { return new Response(null, { status: 204, headers: CORS }); }
function cors(res) { for (const k in CORS) res.headers.set(k, CORS[k]); return res; }
function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });
}
