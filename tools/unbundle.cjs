#!/usr/bin/env node
/**
 * unbundle.cjs — turn a self-unpacking "Bundled Page" index.html into normal
 * static files (a small index.html + an assets/ folder), preserving the design
 * byte-for-byte. Only the loading mechanism changes (no runtime unpack/document
 * swap), so the rendered page is identical.
 *
 * Use it if you ever re-export the design from the bundler and it overwrites
 * index.html with the 3.9MB self-unpacking version again:
 *
 *   node tools/unbundle.cjs        # writes index.unbundled.html + assets/
 *   # open index.unbundled.html, confirm it looks right, then:
 *   mv index.unbundled.html index.html
 *
 * It faithfully replays what the runtime unpacker does: decode each manifest
 * asset (gunzip if compressed) to a real file, rewrite the UUID references to
 * those file paths, strip integrity/crossorigin, and set window.__resources.
 * It also re-adds the analytics tracker tag and defers head scripts.
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const tagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m; const scripts = [];
while ((m = tagRe.exec(src))) scripts.push({ attrs: m[1], body: m[2] });
const grab = (t) => { const s = scripts.find(s => new RegExp('type="' + t + '"').test(s.attrs)); return s ? s.body : null; };

const manifestRaw = grab('__bundler/manifest');
const templateRaw = grab('__bundler/template');
if (!manifestRaw || !templateRaw) { console.error('index.html is not a bundle (no manifest/template). Nothing to do.'); process.exit(1); }
const manifest = JSON.parse(manifestRaw);
let template = JSON.parse(templateRaw);
const extRaw = grab('__bundler/ext_resources');
const extResources = extRaw ? JSON.parse(extRaw.trim() || '[]') : [];

const EXT = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/svg+xml':'svg','image/avif':'avif','font/woff2':'woff2','font/woff':'woff','font/ttf':'ttf','text/javascript':'js','application/javascript':'js','text/css':'css','application/json':'json' };

const assetsDir = path.join(ROOT, 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

const uuidToPath = {};
let total = 0;
for (const uuid of Object.keys(manifest)) {
  const e = manifest[uuid];
  let buf = Buffer.from(e.data, 'base64');
  if (e.compressed) {
    try { buf = zlib.gunzipSync(buf); }
    catch (err) { try { buf = zlib.inflateSync(buf); } catch (e2) { console.error('decompress failed for', uuid, err.message); } }
  }
  const ext = EXT[e.mime] || (e.mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
  fs.writeFileSync(path.join(assetsDir, uuid + '.' + ext), buf);
  uuidToPath[uuid] = 'assets/' + uuid + '.' + ext;
  total += buf.length;
}

for (const uuid of Object.keys(uuidToPath)) template = template.split(uuid).join(uuidToPath[uuid]);
template = template.replace(/\s+integrity="[^"]*"/gi, '').replace(/\s+crossorigin="[^"]*"/gi, '');

const resourceMap = {};
for (const r of extResources) if (uuidToPath[r.uuid]) resourceMap[r.id] = uuidToPath[r.uuid];

const inject =
  '\n  <script>window.__resources = ' + JSON.stringify(resourceMap).split('</script>').join('<\\/script>') + ';</script>' +
  '\n  <!-- Visitor analytics — self-hosted Cloudflare Worker + D1. Setup: /analytics/README.md -->' +
  '\n  <script src="/analytics/tracker.js" defer></script>';
template = template.replace(/<head[^>]*>/i, (h) => h + inject);
template = template.replace(/<head[^>]*>[\s\S]*?<\/head>/i, (head) =>
  head.replace(/<script\b([^>]*\bsrc=[^>]*)>/gi, (mm, a) =>
    /\bdefer\b|\basync\b|text\/babel/i.test(a) ? mm : '<script ' + a.trim() + ' defer>'));

fs.writeFileSync(path.join(ROOT, 'index.unbundled.html'), template);
console.log('Wrote index.unbundled.html (' + (template.length / 1024).toFixed(1) + ' KB) and ' +
  Object.keys(manifest).length + ' files to assets/ (' + (total / 1048576).toFixed(2) + ' MB).');
console.log('Review index.unbundled.html, then:  mv index.unbundled.html index.html');
