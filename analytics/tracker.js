/* Lightweight first-party visitor tracker for the site.
 * Sends pageviews, link clicks, scroll depth and engagement time to the
 * Cloudflare Worker, which adds IP/geo at the edge and stores them in D1.
 * No external dependencies, no third-party requests.
 */
(function () {
  "use strict";

  /* === CONFIG ============================================================
     After deploying the Worker, paste its URL here (NO trailing slash), e.g.
       var ENDPOINT = "https://site-analytics.yourname.workers.dev";
     ===================================================================== */
  var ENDPOINT = "https://site-analytics.kushlesh-iitb.workers.dev";

  if (!ENDPOINT || ENDPOINT === "REPLACE_WITH_WORKER_URL") return; // not configured yet

  // ---- visitor + session identity (first-party storage only) ----
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function get(store, k) { try { return store.getItem(k); } catch (e) { return null; } }
  function set(store, k, v) { try { store.setItem(k, v); } catch (e) {} }

  var visitorId = get(localStorage, "__an_vid");
  if (!visitorId) { visitorId = uuid(); set(localStorage, "__an_vid", visitorId); }
  var visitNo = (parseInt(get(localStorage, "__an_vno") || "0", 10) || 0) + 1;
  set(localStorage, "__an_vno", String(visitNo));

  var sessionId = get(sessionStorage, "__an_sid");
  if (!sessionId) { sessionId = uuid(); set(sessionStorage, "__an_sid", sessionId); }

  // ---- shared fields on every event ----
  var qs = new URLSearchParams(location.search);
  function connType() { var c = navigator.connection; return c ? (c.effectiveType || "") : ""; }
  function base() {
    return {
      visitor_id: visitorId,
      session_id: sessionId,
      visit_no: visitNo,
      url: location.href,
      path: location.pathname,
      hash: location.hash,
      title: document.title,
      referrer: document.referrer,
      utm_source: qs.get("utm_source") || "",
      utm_medium: qs.get("utm_medium") || "",
      utm_campaign: qs.get("utm_campaign") || "",
      screen_w: screen.width,
      screen_h: screen.height,
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      lang: navigator.language || "",
      client_tz: (Intl.DateTimeFormat().resolvedOptions().timeZone) || "",
      color_scheme: (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light",
      connection: connType(),
    };
  }
  function send(payload) {
    try {
      var data = JSON.stringify(payload);
      var url = ENDPOINT + "/collect";
      // text/plain avoids a CORS preflight; the Worker parses it as JSON.
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([data], { type: "text/plain" }));
      } else {
        fetch(url, { method: "POST", body: data, keepalive: true,
          headers: { "content-type": "text/plain" } });
      }
    } catch (e) { /* never let tracking break the page */ }
  }

  // ---- pageview (after load, so we can include load timing) ----
  function loadMs() {
    try {
      var nav = performance.getEntriesByType("navigation")[0];
      if (nav) return Math.round(nav.duration);
      var t = performance.timing;
      return t ? (t.loadEventEnd - t.navigationStart) : null;
    } catch (e) { return null; }
  }
  function pageview() {
    var p = base();
    p.type = "pageview";
    p.value = visitNo;            // value on a pageview = visit number (1 = first ever)
    p.load_ms = loadMs();
    send(p);
  }
  if (document.readyState === "complete") pageview();
  else window.addEventListener("load", pageview, { once: true });

  // ---- click tracking (delegated on document, survives DOM swaps) ----
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("a,button,[data-track]") : null;
    if (!el) return;
    var href = el.getAttribute("href") || el.getAttribute("data-track") || "";
    var type = "click";
    if (href && /^https?:\/\//i.test(href)) {
      if (/\.(pdf|zip|docx?|xlsx?|pptx?|csv|png|jpe?g|svg|mp4|mp3)(\?|#|$)/i.test(href)) type = "download";
      else if (href.indexOf(location.host) === -1) type = "outbound";
    }
    var p = base();
    p.type = type;
    p.target = href || (el.id ? "#" + el.id : el.tagName.toLowerCase());
    p.target_text = (el.innerText || el.textContent || "").trim().slice(0, 120);
    send(p);
  }, true);

  // ---- scroll depth (25 / 50 / 75 / 100, once each) ----
  var marks = { 25: false, 50: false, 75: false, 100: false };
  var onScroll = throttle(function () {
    var doc = document.documentElement;
    var height = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (height <= 0) return;
    var pct = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / height) * 100));
    [25, 50, 75, 100].forEach(function (m) {
      if (!marks[m] && pct >= m) {
        marks[m] = true;
        var p = base(); p.type = "scroll"; p.value = m; send(p);
      }
    });
  }, 500);
  window.addEventListener("scroll", onScroll, { passive: true });

  // ---- active engagement time ----
  var activeMs = 0, last = Date.now(), visible = !document.hidden;
  function accrue() { var now = Date.now(); if (visible) activeMs += now - last; last = now; }
  setInterval(accrue, 1000);
  document.addEventListener("visibilitychange", function () {
    accrue();
    visible = !document.hidden;
    last = Date.now();
    if (document.hidden) ping();           // most reliable "leaving" signal on mobile
  });
  function ping() {
    accrue();
    var p = base();
    p.type = "ping";
    p.value = Math.round(activeMs / 1000);  // value on a ping = active seconds so far
    send(p);
  }
  window.addEventListener("pagehide", ping);

  function throttle(fn, ms) {
    var t = 0;
    return function () { var now = Date.now(); if (now - t >= ms) { t = now; fn(); } };
  }
})();
