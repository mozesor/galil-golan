// galil-push: tiny push server for the parents' site.
//   POST /subscribe    {subscription}            from the site (origin-checked)
//   POST /unsubscribe  {endpoint}                from the site
//   POST /prefs        {endpoint, prefs:{type:bool}} from the site: which notification types this subscriber wants
//   POST /notify       {items:[{key,type,title,body,url?,badge?}]}   from GitHub Actions (Bearer PUSH_SECRET)
//                      type (or the key prefix) is matched against each subscriber's prefs; a type set to false is skipped
//                      each key is queued at most once, ever (dedup in KV), so the Action can resend candidates freely
//   POST /hit          {id, standalone}          from the site, at most once an hour per device: anonymous visit counter
//                      stored as hit:<day>:<s|w>:<hash(id)> for 40 days; no names, no addresses
//   GET  /stats                                  subscriber count + visits per day for the last 7 days (public, numbers only)
//
// 20/11/2026 (audit): all five sites share one Cloudflare account and its free-plan quotas (1,000 KV lists and 1,000
// KV writes a day, 50 outgoing requests per invocation). So:
//   - deliveries go through a queue ("queue" key) drained at most SEND_BUDGET per invocation, by /notify and by a
//     cron every few minutes; a parent past the 50th delivery is no longer silently skipped
//   - a failed delivery is retried per device, at most MAX_TRIES times, then dropped (no endless resends)
//   - /stats is cached (memory 2 min, KV 1 hour, finished days kept for good): an anonymous caller cannot burn the lists
//   - /hit and /subscribe are capped per IP in memory, and subscriptions must point at a real push service
//   - one delivery log per run (not one per device)
import { buildPushPayload } from "@block65/webcrypto-web-push";

const SEND_BUDGET = 40;   // outgoing pushes per invocation (free plan: 50 subrequests)
const MAX_TRIES = 3;      // per device and item
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.services\.mozilla\.com$/];

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

const cors = (env, req) => {
  const origin = req.headers.get("origin") || "";
  const ok = origin === env.ALLOWED_ORIGIN;
  return {
    ok,
    headers: {
      "access-control-allow-origin": ok ? origin : env.ALLOWED_ORIGIN,
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  };
};

const keyFor = async (endpoint) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "sub:" + [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const cleanPrefs = (p) => { const o = {}; if (p && typeof p === "object") for (const [k, v] of Object.entries(p)) if (/^[a-z]{1,16}$/.test(k)) o[k] = !!v; return o; };
const wants = (sub, it) => { const t = it.type || String(it.key).split(":")[0]; if (t === "all") return !!(sub.prefs && sub.prefs.all === true); return !(sub.prefs && sub.prefs[t] === false); };

const pushHostOk = (endpoint) => { try { const u = new URL(endpoint); return u.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch { return false; } };
const validSub = (s) =>
  s && typeof s.endpoint === "string" && s.endpoint.length < 2000 && pushHostOk(s.endpoint) &&
  s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string" && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;

// per-isolate rate limit: best effort, but it stops a single script from writing thousands of keys
const hits = new Map();
const limited = (req, what, max) => {
  const ip = req.headers.get("cf-connecting-ip") || "?";
  const k = `${what}|${dayIL()}|${ip}`;
  const n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  if (hits.size > 5000) hits.clear();
  return n > max;
};

const hashId = async (id) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hit|" + id));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
};
const dayIL = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);
async function listPrefix(env, prefix) {
  const out = []; let cursor;
  do { const page = await env.SUBS.list({ prefix, cursor }); out.push(...page.keys.map((k) => k.name)); cursor = page.list_complete ? undefined : page.cursor; } while (cursor);
  return out;
}
async function dayStats(env, day) {
  const keys = await listPrefix(env, `hit:${day}:`);
  const devices = new Set(), homeSet = new Set();
  for (const k of keys) { const [, , mode, h] = k.split(":"); devices.add(h); if (mode === "s") homeSet.add(h); }
  return { day, devices: devices.size, home: homeSet.size, ids: [...devices] };
}
async function visitStats(env) {
  const days = [], all = new Set();
  for (let i = 0; i < 7; i++) {
    const day = dayIL(new Date(Date.now() - i * 86400000));
    let d = i > 0 ? await env.SUBS.get("statday:" + day, "json") : null;   // a finished day never changes
    if (!d) { d = await dayStats(env, day); if (i > 0) await env.SUBS.put("statday:" + day, JSON.stringify(d), { expirationTtl: 10 * 86400 }); }
    for (const h of d.ids) all.add(h);
    days.push({ day: d.day, devices: d.devices, home: d.home });
  }
  return { days, week: all.size };
}
let statsMem = null;
async function stats(env) {
  if (statsMem && Date.now() - statsMem.at < 2 * 60000) return statsMem.v;
  let v = await env.SUBS.get("statscache", "json");
  if (!v || Date.now() - v.at > 3600000) {
    const n = (await listAll(env)).length;
    v = { subscribers: n, ...(await visitStats(env)), at: Date.now() };
    await env.SUBS.put("statscache", JSON.stringify(v), { expirationTtl: 2 * 86400 });
  }
  statsMem = { at: Date.now(), v };
  return v;
}

async function listAll(env) { return listPrefix(env, "sub:"); }

async function sendOne(env, sub, item) {
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const message = {
    data: JSON.stringify({ title: item.title, body: item.body, url: item.url || env.SITE_URL, tag: item.key, badge: item.badge ?? 1 }),
    options: { ttl: 24 * 3600, urgency: "normal" },
  };
  const payload = await buildPushPayload(message, sub, vapid);
  const res = await fetch(sub.endpoint, payload);
  return res.status;
}

// the queue: { items: {key: item}, todo: [[subKey, itemKey, tries], ...] }
// a short lock so the cron and /notify never read-modify-write the queue at the same time
async function lock(env) { if (await env.SUBS.get("qlock")) return false; await env.SUBS.put("qlock", "1", { expirationTtl: 60 }); return true; }
async function drain(env, locked = false) {
  const q = await env.SUBS.get("queue", "json");
  if (!q || !q.todo || !q.todo.length) { if (locked) await env.SUBS.delete("qlock"); return { sent: 0, left: 0 }; }
  if (!locked && !(await lock(env))) return { sent: 0, left: q.todo.length, locked: true };
  let sent = 0, failed = 0, dropped = 0, budget = SEND_BUDGET;
  const later = [], log = [], gone = new Set(), subs = new Map();
  for (const entry of q.todo) {
    const [sk, ik, tries = 0] = entry;
    if (gone.has(sk) || !q.items[ik]) continue;
    if (budget <= 0) { later.push(entry); continue; }
    if (!subs.has(sk)) subs.set(sk, await env.SUBS.get(sk, "json"));
    const sub = subs.get(sk);
    if (!sub) { gone.add(sk); continue; }
    budget--;
    let status = 0;
    try { status = await sendOne(env, sub, q.items[ik]); } catch { status = 0; }
    log.push(`${sk.slice(4, 10)}:${ik}:${status}`);
    if (status === 404 || status === 410) { await env.SUBS.delete(sk); gone.add(sk); dropped++; continue; }
    if (status >= 200 && status < 300) { sent++; continue; }
    failed++;
    if (tries + 1 < MAX_TRIES) later.push([sk, ik, tries + 1]);
  }
  const todo = later.filter(([sk]) => !gone.has(sk));
  const used = new Set(todo.map((e) => e[1]));
  const items = {}; for (const k of used) items[k] = q.items[k];
  if (todo.length) await env.SUBS.put("queue", JSON.stringify({ items, todo }));
  else await env.SUBS.delete("queue");
  // one delivery log per run (7 days), so "I did not get it" can be checked against the push service's answer
  if (log.length) await env.SUBS.put(`log:${new Date().toISOString().slice(0, 16)}:${Math.random().toString(36).slice(2, 6)}`, log.join("\n"), { expirationTtl: 7 * 86400 });
  await env.SUBS.delete("qlock");
  return { sent, failed, dropped, left: todo.length };
}

export default {
  async scheduled(_ev, env, ctx) { ctx.waitUntil(drain(env)); },

  async fetch(req, env) {
    const url = new URL(req.url);
    const c = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c.headers });

    if (url.pathname === "/stats" && req.method === "GET") {
      const v = await stats(env);
      return json({ subscribers: v.subscribers, days: v.days, week: v.week, at: new Date(v.at).toISOString() }, 200, { ...c.headers, "cache-control": "public, max-age=120" });
    }

    if (url.pathname === "/hit" && req.method === "POST") {
      if (!c.ok) return json({ error: "origin" }, 403, c.headers);
      if (limited(req, "hit", 30)) return json({ ok: true }, 200, c.headers);   // silently ignored
      let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400, c.headers); }
      if (typeof body?.id !== "string" || !body.id || body.id.length > 64) return json({ error: "id" }, 400, c.headers);
      const k = `hit:${dayIL()}:${body.standalone ? "s" : "w"}:${await hashId(body.id)}`;
      await env.SUBS.put(k, "1", { expirationTtl: 40 * 86400 });
      return json({ ok: true }, 200, c.headers);
    }

    if (url.pathname === "/subscribe" && req.method === "POST") {
      if (!c.ok) return json({ error: "origin" }, 403, c.headers);
      if (limited(req, "sub", 20)) return json({ error: "rate" }, 429, c.headers);
      let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400, c.headers); }
      const sub = body?.subscription;
      if (!validSub(sub)) return json({ error: "subscription" }, 400, c.headers);
      const k = await keyFor(sub.endpoint);
      const old = await env.SUBS.get(k, "json");
      if (!old) await env.SUBS.delete("nosubs");
      const prefs = body.prefs ? cleanPrefs(body.prefs) : old?.prefs || {};
      await env.SUBS.put(k, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null, ua: (req.headers.get("user-agent") || "").slice(0, 120), at: old?.at || Date.now(), updatedAt: Date.now(), prefs }));
      return json({ ok: true, prefs, id: k.slice(4, 10) }, 200, c.headers);
    }

    if (url.pathname === "/unsubscribe" && req.method === "POST") {
      if (!c.ok) return json({ error: "origin" }, 403, c.headers);
      let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400, c.headers); }
      if (typeof body?.endpoint !== "string") return json({ error: "endpoint" }, 400, c.headers);
      await env.SUBS.delete(await keyFor(body.endpoint));
      return json({ ok: true }, 200, c.headers);
    }

    if (url.pathname === "/prefs" && req.method === "POST") {
      if (!c.ok) return json({ error: "origin" }, 403, c.headers);
      let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400, c.headers); }
      if (typeof body?.endpoint !== "string") return json({ error: "endpoint" }, 400, c.headers);
      const k = await keyFor(body.endpoint);
      const sub = await env.SUBS.get(k, "json");
      if (!sub) return json({ error: "unknown" }, 404, c.headers);
      sub.prefs = cleanPrefs(body.prefs); sub.updatedAt = Date.now();
      await env.SUBS.put(k, JSON.stringify(sub));
      return json({ ok: true, prefs: sub.prefs, id: k.slice(4, 10) }, 200, c.headers);
    }

    // a test message to one device only (the caller's own subscription), for checking that notifications arrive
    if (url.pathname === "/test" && req.method === "POST") {
      if (!c.ok) return json({ error: "origin" }, 403, c.headers);
      if (limited(req, "test", 10)) return json({ error: "rate" }, 429, c.headers);
      let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400, c.headers); }
      if (typeof body?.endpoint !== "string") return json({ error: "endpoint" }, 400, c.headers);
      const k = await keyFor(body.endpoint);
      const sub = await env.SUBS.get(k, "json");
      if (!sub) return json({ error: "unknown" }, 404, c.headers);
      let status = 0;
      try { status = await sendOne(env, sub, { key: "test:" + Date.now(), title: "בדיקת התראות", body: "ההתראות מגיעות למכשיר הזה. מזהה: " + k.slice(4, 10) }); } catch (e) { return json({ error: String(e) }, 500, c.headers); }
      return json({ ok: status >= 200 && status < 300, status, id: k.slice(4, 10) }, 200, c.headers);
    }

    if (url.pathname === "/notify" && req.method === "POST") {
      const auth = req.headers.get("authorization") || "";
      if (!env.PUSH_SECRET || auth !== `Bearer ${env.PUSH_SECRET}`) return json({ error: "auth" }, 401);
      let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400); }
      const items = Array.isArray(body?.items) ? body.items : [];
      // the subscriber list is read only when there is something new to queue: a KV list is the scarce operation
      const fresh = [], seen = new Set();
      for (const it of items) {
        if (fresh.length >= 40) break;
        if (!it || typeof it.key !== "string" || typeof it.title !== "string" || typeof it.body !== "string") continue;
        if (seen.has(it.key)) continue; seen.add(it.key);
        if (await env.SUBS.get("sent:" + it.key, { cacheTtl: 60 })) continue;
        fresh.push(it);
      }
      let queued = 0, subscribers;
      if (fresh.length) {
        // the queue is being drained right now: leave the items unmarked, the next run (minutes away) queues them
        if (!(await lock(env))) return json({ queued: 0, items: fresh.length, busy: true });
        // with nobody subscribed yet, keep the items unsent so the first subscribers still get them
        if (await env.SUBS.get("nosubs")) { await env.SUBS.delete("qlock"); return json({ queued: 0, items: fresh.length, subscribers: 0, deferred: true }); }
        const keys = await listAll(env);
        subscribers = keys.length;
        if (!keys.length) {
          await env.SUBS.put("nosubs", "1", { expirationTtl: 6 * 3600 });
          await env.SUBS.delete("qlock");
          return json({ queued: 0, items: fresh.length, subscribers: 0, deferred: true });
        }
        const q = (await env.SUBS.get("queue", "json")) || { items: {}, todo: [] };
        for (const k of keys) {
          const sub = await env.SUBS.get(k, "json");
          if (!sub) continue;
          for (const it of fresh) {
            if (!wants(sub, it)) continue;
            q.items[it.key] = { key: it.key, title: it.title.slice(0, 200), body: it.body.slice(0, 1000), url: it.url, badge: it.badge };
            q.todo.push([k, it.key, 0]);
            queued++;
          }
        }
        if (queued) await env.SUBS.put("queue", JSON.stringify(q));
        // once queued, a key is never queued again (the queue itself retries failed devices)
        for (const it of fresh) await env.SUBS.put("sent:" + it.key, String(Date.now()), { expirationTtl: 180 * 24 * 3600 });
      }
      const r = await drain(env, fresh.length > 0);
      return json({ ...r, queued, items: fresh.length, subscribers });
    }

    return json({ error: "not found" }, 404);
  },
};
