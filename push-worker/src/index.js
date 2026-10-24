// galil-push: tiny push server for the parents' site.
//   POST /subscribe    {subscription}            from the site (origin-checked)
//   POST /unsubscribe  {endpoint}                from the site
//   POST /prefs        {endpoint, prefs:{type:bool}} from the site: which notification types this subscriber wants
//   POST /notify       {items:[{key,type,title,body,url?,badge?}]}   from GitHub Actions (Bearer PUSH_SECRET)
//                      type (or the key prefix) is matched against each subscriber's prefs; a type set to false is skipped
//                      each key is sent at most once, ever (dedup in KV), so the Action can resend candidates freely
//   POST /hit          {id, standalone}          from the site, at most once an hour per device: anonymous visit counter
//                      stored as hit:<day>:<s|w>:<hash(id)> for 40 days; no names, no addresses
//   GET  /stats                                  subscriber count + visits per day for the last 7 days (public, numbers only)
import { buildPushPayload } from "@block65/webcrypto-web-push";

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

const validSub = (s) =>
  s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 2000 &&
  s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";

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
async function visitStats(env) {
  const days = [];
  const all = new Set();
  for (let i = 0; i < 7; i++) {
    const day = dayIL(new Date(Date.now() - i * 86400000));
    const keys = await listPrefix(env, `hit:${day}:`);
    const devices = new Set(), homeSet = new Set();
    for (const k of keys) { const [, , mode, h] = k.split(":"); devices.add(h); if (mode === "s") homeSet.add(h); all.add(h); }
    days.push({ day, devices: devices.size, home: homeSet.size });
  }
  return { days, week: all.size };
}

async function listAll(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: "sub:", cursor });
    out.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const c = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c.headers });

    if (url.pathname === "/stats" && req.method === "GET") {
      const n = (await listAll(env)).length;
      const visits = await visitStats(env);
      return json({ subscribers: n, ...visits }, 200, c.headers);
    }

    if (url.pathname === "/hit" && req.method === "POST") {
      if (!c.ok) return json({ error: "origin" }, 403, c.headers);
      let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400, c.headers); }
      if (typeof body?.id !== "string" || !body.id || body.id.length > 64) return json({ error: "id" }, 400, c.headers);
      const k = `hit:${dayIL()}:${body.standalone ? "s" : "w"}:${await hashId(body.id)}`;
      await env.SUBS.put(k, "1", { expirationTtl: 40 * 86400 });
      return json({ ok: true }, 200, c.headers);
    }

    if (url.pathname === "/subscribe" && req.method === "POST") {
      if (!c.ok) return json({ error: "origin" }, 403, c.headers);
      let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400, c.headers); }
      const sub = body?.subscription;
      if (!validSub(sub)) return json({ error: "subscription" }, 400, c.headers);
      const k = await keyFor(sub.endpoint);
      const old = await env.SUBS.get(k, "json");
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
      const keys = await listAll(env);
      const fresh = [], seen = new Set();
      for (const it of items) {
        if (fresh.length >= 40) break;
        if (!it || typeof it.key !== "string" || typeof it.title !== "string" || typeof it.body !== "string") continue;
        if (seen.has(it.key)) continue; seen.add(it.key);
        if (await env.SUBS.get("sent:" + it.key, { cacheTtl: 60 })) continue;
        // claim the key before sending so two runs a minute apart cannot both send it; the claim is short until
        // at least one device accepted the message, so a failed delivery is retried by a later run
        if (keys.length) await env.SUBS.put("sent:" + it.key, String(Date.now()), { expirationTtl: 15 * 60 });
        fresh.push(it);
      }
      if (!fresh.length) return json({ sent: 0, items: 0, subscribers: keys.length });
      // with nobody subscribed yet, keep the items unsent so the first subscribers still get them
      if (!keys.length) return json({ sent: 0, items: fresh.length, subscribers: 0, deferred: true });
      let sent = 0, dropped = 0, failed = 0, skipped = 0;
      const okItems = new Set(), failedItems = new Set();
      for (const k of keys) {
        const sub = await env.SUBS.get(k, "json");
        if (!sub) continue;
        for (const it of fresh) {
          if (!wants(sub, it)) { skipped++; continue; }
          try {
            const status = await sendOne(env, sub, it);
            if (status === 404 || status === 410) { await env.SUBS.delete(k); dropped++; break; }
            if (status >= 200 && status < 300) { sent++; okItems.add(it.key); } else { failed++; failedItems.add(it.key); }
          } catch { failed++; failedItems.add(it.key); }
        }
      }
      // settle the claims: delivered (or wanted by nobody) -> remember for 180 days; failed everywhere -> let a later run retry
      for (const it of fresh) {
        if (okItems.has(it.key) || !failedItems.has(it.key)) await env.SUBS.put("sent:" + it.key, String(Date.now()), { expirationTtl: 180 * 24 * 3600 });
      }
      return json({ sent, failed, dropped, skipped, items: fresh.length, subscribers: keys.length });
    }

    return json({ error: "not found" }, 404);
  },
};
