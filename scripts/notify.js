// Computes push notifications from data.json and sends them to the push worker.
// Runs after fetch-data.js in the GitHub Action. Idempotent: every item has a stable key, the worker sends each key once.
//   result:<gameId>            our game got a score
//   time:<gameId>:<HH:MM>:<venue>   a confirmed time/venue for our next game (within 10 days)
//   reminder:<gameId>          our game is tomorrow (Israel time)
//   cup:<date>:<opp>           a new cup game appeared
//   league:<round>             every game of a league round finished: one digest of the results
//   rank:<date>:<rank>         our place in the table changed today
// every item carries a type (the key prefix); subscribers can switch types off in the site
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TZ = "Asia/Jerusalem";
const SERVER = process.env.PUSH_SERVER || (JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "config.json"), "utf8")).push?.server) || "https://galil-push.mozesor.workers.dev";
const SECRET = process.env.PUSH_SECRET;

const read = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch { return fb; } };
const data = read("data.json", null), cfg = read("config.json", null), ovr = read("overrides.json", {});
if (!data || !cfg) { console.log("notify: no data"); process.exit(0); }
if (!SECRET) { console.log("notify: PUSH_SECRET missing, skipping"); process.exit(0); }

const parts = (d) => { const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value; if (o.hour === "24") o.hour = "00"; return o; };
const isoOf = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const heb = (s) => String(s || "").replace(/'/g, "׳").replace(/"/g, "״");
const shortName = (n) => heb(String(n).replace(/^(מ\.כ\.?|מ\.ס\.?|ה\.|מועדון הכדורגל|מרכז קהילתי|איחוד)\s*/, "").replace(/\s*צו פיוס\s*$/, "").trim() || n);
const isMe = (t) => t.name.includes(cfg.team.match) && !(cfg.team.exclude && t.name.includes(cfg.team.exclude));
const validTime = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : null; };
function gameTime(g) {
  const p = parts(new Date(g.date)); const oneIso = `${p.year}-${p.month}-${p.day}`;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(g.ifa?.date || "") ? g.ifa.date : oneIso;
  const ov = validTime(ovr?.games?.[g.id]?.time); if (ov) return { iso, time: ov };
  const oneTbd = (p.hour === "00" || p.hour === "01") && p.minute === "00";
  if (!oneTbd) return { iso: oneIso, time: `${p.hour}:${p.minute}` };
  const it = validTime(g.ifa?.time); if (it) return { iso, time: it };
  return { iso, time: null };
}
const venueOf = (g, home) => ovr?.games?.[g.id]?.venue || g.ifa?.venue || (home ? ovr?.venues?.home?.name || "" : "");
const heDate = (iso) => new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(new Date(iso + "T12:00:00Z"));
const addDays = (iso, n) => isoOf(new Date(new Date(iso + "T12:00:00Z").getTime() + n * 86400000));

const mine = data.games.filter((g) => isMe(g.home) || isMe(g.away)).map((g) => ({ ...g, cup: false }))
  .concat((data.cup?.games || []).map((g) => ({ ...g, cup: true })))
  .sort((a, b) => a.date.localeCompare(b.date));
const today = isoOf(new Date()), tomorrow = addDays(today, 1);
const url = cfg.push?.url || cfg.site?.url || "https://mozesor.github.io/galil-golan/";
const items = [];
const heTeam = (n) => heb(shortName(n));

for (const g of mine) {
  const home = isMe(g.home), opp = shortName((home ? g.away : g.home).name), played = g.home.goals !== null && g.away.goals !== null;
  const t = gameTime(g);
  const label = g.cup ? `גביע, ${heb(g.roundName || "")}` : `מחזור ${g.round}`;
  if (played) {
    const my = home ? g.home.goals : g.away.goals, op = home ? g.away.goals : g.home.goals;
    const title = my > op ? `ניצחנו ${my}:${op}!` : my < op ? `הפסדנו ${my}:${op}` : `תיקו ${my}:${op}`;
    // only recent games get a push (a backfill of old results would spam)
    if (t.iso >= addDays(today, -3)) items.push({ type: "result", key: `result:${g.id}`, title, body: `${home ? "בבית" : "בחוץ"} מול ${opp}. ${label}.`, url: url + "#games" });
    continue;
  }
  if (t.iso < today) continue;
  const venue = venueOf(g, home);
  if (g.cup && t.iso >= today) items.push({ type: "cup", key: `cup:${t.iso}:${opp}`, title: "הגרלת הגביע פורסמה", body: `${heb(g.roundName || "")}: ${home ? "בבית" : "בחוץ"} מול ${opp}, ${heDate(t.iso)}${t.time ? " בשעה " + t.time : ""}.`, url });
  if (t.time && t.iso <= addDays(today, 10)) items.push({ type: "time", key: `time:${g.id}:${t.time}:${venue}`, title: `נקבעה שעה למשחק מול ${opp}`, body: `${heDate(t.iso)} בשעה ${t.time}${venue ? ", " + heb(venue) : ""}. ${home ? "משחק בית" : "משחק חוץ"}.`, url });
  if (t.iso === tomorrow) items.push({ type: "reminder", key: `reminder:${g.id}`, title: `מחר משחק מול ${opp}`, body: `${t.time ? "בשעה " + t.time : "השעה טרם פורסמה"}${venue ? ", " + heb(venue) : ""}. ${home ? "משחק בית" : "משחק חוץ"}. בהצלחה!`, url });
}

// every finished league game (not ours), as it ends: off by default in the site, parents opt in
for (const g of data.games) {
  if (!g.round || g.home.goals === null || g.away.goals === null || isMe(g.home) || isMe(g.away)) continue;
  const iso = isoOf(new Date(g.date)); if (iso < addDays(today, -1)) continue;
  items.push({ type: "all", key: `all:${g.id}`, title: `${heTeam(g.home.name)} ${g.home.goals}:${g.away.goals} ${heTeam(g.away.name)}`, body: `מחזור ${g.round}, ${heDate(iso)}.`, url: url + "#games" });
}
// league round digest: once every game of the round has a score (and the last of them was played recently)
const byRound = new Map();
for (const g of data.games) { if (!byRound.has(g.round)) byRound.set(g.round, []); byRound.get(g.round).push(g); }
for (const [round, gs] of byRound) {
  if (!round || gs.length < 2) continue;
  const done = gs.every((g) => g.home.goals !== null && g.away.goals !== null);
  const last = gs.map((g) => isoOf(new Date(g.date))).sort().pop();
  if (!done || last < addDays(today, -2)) continue;
  const lines = gs.slice().sort((a, b) => a.date.localeCompare(b.date)).map((g) => `${heTeam(g.home.name)} ${g.home.goals}:${g.away.goals} ${heTeam(g.away.name)}`);
  const me = (data.standings || []).find((r) => isMe(r));
  items.push({ type: "league", key: `league:${round}`, title: `סיכום מחזור ${round}`, body: lines.join("\n").slice(0, 900) + (me ? `\nאנחנו במקום ${me.rank} עם ${me.points} נק׳.` : ""), url: url + "#table" });
}
// table position changed today (fetch-data writes rankChange when the rank moves between two runs)
const rc = data.rankChange;
if (rc && rc.at && isoOf(new Date(rc.at)) === today && rc.from && rc.to && rc.from !== rc.to) {
  const up = rc.to < rc.from;
  items.push({ type: "rank", key: `rank:${today}:${rc.to}`, title: up ? `עלינו למקום ${rc.to} בטבלה` : `ירדנו למקום ${rc.to} בטבלה`, body: `ממקום ${rc.from} למקום ${rc.to}${rc.points != null ? `, ${rc.points} נק׳` : ""}${rc.round ? ` אחרי מחזור ${rc.round}` : ""}.`, url: url + "#table" });
}

(async () => {
  if (!items.length) { console.log("notify: nothing to send"); return; }
  const r = await fetch(SERVER + "/notify", { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ items }) });
  const j = await r.json().catch(() => ({}));
  console.log(`notify: ${items.length} candidates ->`, r.status, JSON.stringify(j));
})().catch((e) => { console.error("notify failed:", e); });
