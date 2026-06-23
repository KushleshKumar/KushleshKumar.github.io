#!/usr/bin/env node
/**
 * optimize-images.cjs — re-encode each <img> that points at assets/*.jpg|png to
 * modern formats and wrap it in <picture> (AVIF -> WebP -> original fallback),
 * so every browser gets the smallest format it supports with zero visible
 * change. Dimensions are preserved (no resizing); JPEG fallbacks are shrunk
 * in place, PNG fallbacks are kept lossless.
 *
 * Requires sharp:  npm i sharp
 * Run from repo root:  node tools/optimize-images.cjs
 * Idempotent — re-running skips images already wrapped.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// quality: visually-lossless settings, a touch higher for graphics (PNG sources)
const Q = { jpgFallback: 84, photoAvif: 60, photoWebp: 82, gfxAvif: 66, gfxWebp: 88 };
const kb = (p) => (fs.statSync(p).size / 1024).toFixed(0) + 'KB';

(async () => {
  const re = /<img\b[^>]*?\bsrc="(assets\/([^"?#]+)\.(jpe?g|png))"[^>]*>/gi;
  const tags = [];
  let m;
  while ((m = re.exec(html))) tags.push({ tag: m[0], rel: m[1], base: m[2], ext: m[3].toLowerCase() });

  let before = 0, deliveredAvif = 0;
  for (const t of tags) {
    const src = path.join(ROOT, t.rel);
    if (!fs.existsSync(src)) { console.log('skip (missing):', t.rel); continue; }
    const isPng = t.ext === 'png';
    const avifRel = 'assets/' + t.base + '.avif';
    const webpRel = 'assets/' + t.base + '.webp';
    const already = html.includes('srcset="' + avifRel + '"');

    before += fs.statSync(src).size;
    if (!already) {
      await sharp(src).avif({ quality: isPng ? Q.gfxAvif : Q.photoAvif }).toFile(path.join(ROOT, avifRel));
      await sharp(src).webp({ quality: isPng ? Q.gfxWebp : Q.photoWebp }).toFile(path.join(ROOT, webpRel));
      if (!isPng) {
        const buf = await sharp(src).jpeg({ quality: Q.jpgFallback, mozjpeg: true }).toBuffer();
        if (buf.length < fs.statSync(src).size) fs.writeFileSync(src, buf);
      }
      const picture = '<picture style="display:contents">' +
        '<source srcset="' + avifRel + '" type="image/avif">' +
        '<source srcset="' + webpRel + '" type="image/webp">' +
        t.tag + '</picture>';
      html = html.split(t.tag).join(picture);
    }
    deliveredAvif += fs.statSync(path.join(ROOT, avifRel)).size;
    console.log(t.base.slice(0, 8) + (already ? ' (already done)' : '') +
      '  fallback ' + kb(src) + ' | avif ' + kb(path.join(ROOT, avifRel)) + ' | webp ' + kb(path.join(ROOT, webpRel)));
  }
  fs.writeFileSync(path.join(ROOT, 'index.html'), html);
  console.log('\n<picture> blocks now: ' + (html.match(/<picture/g) || []).length);
  console.log('raster originals ' + (before / 1048576).toFixed(2) + ' MB  ->  AVIF delivered ' + (deliveredAvif / 1024).toFixed(0) + ' KB');
})().catch((e) => { console.error(e); process.exit(1); });
