// Builds calendar files from data.json + overrides.json:
//   season.ics       all of our games, for "subscribe" (auto-updating calendar)
//   ics/<gameId>.ics one file per game, for "add this game"
// No dependencies. Deterministic output (no timestamps), so unchanged data means no git diff.
const fs = require("fs/promises");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TZ = "Asia/Jerusalem";
const DTSTAMP = "20260101T000000Z";

function parts(d) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  if (o.hour === "24") o.hour = "00";
  return o;
}
function israelDate(iso, h, m) {
  const guess = new Date(`${iso}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const p = parts(guess);
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess.getTime() - (wall - guess.getTime()));
}
function validTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
  return m && +m[1] < 24 && +m[2] < 60 ? [+m[1], +m[2]] : null;
}
function gameTime(g, ovr) {
  const d = new Date(g.date);
  const p = parts(d);
  const iso = `${p.year}-${p.month}-${p.day}`;
  const t = validTime(ovr?.games?.[g.id]?.time);
  if (t) return { date: israelDate(iso, t[0], t[1]), tbd: false, iso };
  const tbd = (p.hour === "00" || p.hour === "01") && p.minute === "00";
  return { date: d, tbd, iso };
}
const heb = (s) => String(s || "").replace(/'/g, "׳").replace(/"/g, "״");
function shortName(n) {
  return heb(n.replace(/^(מ\.כ\.?|מ\.ס\.?|ה\.|מועדון הכדורגל|מרכז קהילתי|איחוד)\s*/, "").replace(/\s*צו פיוס\s*$/, "").trim() || n);
}
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// RFC 5545 line folding at 75 octets, never splitting a UTF-8 character
function fold(line) {
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function event(g, cfg, ovr) {
  const isMe = (t) => t.name.includes(cfg.team.match);
  const home = isMe(g.home);
  const opp = home ? g.away : g.home;
  const t = gameTime(g, ovr);
  const o = ovr?.games?.[g.id] || {};
  const hv = ovr?.venues?.home || {};
  const venue = o.venue || (home ? hv.name || "" : "");
  const note = o.note || (home ? hv.note || "" : "");
  const rawWaze = o.waze || (home ? hv.waze || "" : "");
  const waze = /^https:\/\/[^\s"<>]+$/i.test(rawWaze) ? rawWaze : "";
  const played = g.home.goals !== null && g.away.goals !== null;
  const my = home ? g.home.goals : g.away.goals, op = home ? g.away.goals : g.home.goals;
  const score = played ? ` ${my}:${op}` : "";
  const lines = [
    "BEGIN:VEVENT",
    `UID:${g.id}@galil-golan-darom`,
    `DTSTAMP:${DTSTAMP}`,
    `SUMMARY:${esc(`⚽ ${cfg.team.displayName} נגד ${shortName(opp.name)}${score} (${home ? "בית" : "חוץ"})`)}`,
  ];
  if (t.tbd) {
    const next = new Date(israelDate(t.iso, 12, 0).getTime() + 86400000);
    const q = parts(next);
    lines.push(`DTSTART;VALUE=DATE:${t.iso.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${q.year}${q.month}${q.day}`);
  } else {
    lines.push(`DTSTART:${fmt(t.date)}`, `DTEND:${fmt(new Date(t.date.getTime() + 90 * 60000))}`);
  }
  if (venue) lines.push(`LOCATION:${esc(venue)}`);
  const desc = [`מחזור ${g.round}`, t.tbd ? "שעת המשחק טרם פורסמה, היומן יתעדכן כשתפורסם" : "", note, waze].filter(Boolean).join("\n");
  lines.push(`DESCRIPTION:${esc(desc)}`);
  if (!t.tbd && !played) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc("משחק בעוד שעתיים")}`, "TRIGGER:-PT2H", "END:VALARM");
  lines.push("END:VEVENT");
  return lines;
}

function calendar(events, cfg, name) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//galil-golan-darom//he",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    `X-WR-TIMEZONE:${TZ}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
    ...events.flat(),
    "END:VCALENDAR",
  ].map(fold).join("\r\n") + "\r\n";
}

async function buildIcs() {
  const read = async (f, fallback) => { try { return JSON.parse(await fs.readFile(path.join(ROOT, f), "utf8")); } catch { return fallback; } };
  const data = await read("data.json", null);
  const cfg = await read("config.json", null);
  const ovr = await read("overrides.json", {});
  if (!data || !cfg) throw new Error("build-ics: data.json or config.json missing");
  const mine = data.games
    .filter((g) => g.home.name.includes(cfg.team.match) || g.away.name.includes(cfg.team.match))
    .sort((a, b) => a.date.localeCompare(b.date));

  await fs.mkdir(path.join(ROOT, "ics"), { recursive: true });
  const keep = new Set();
  for (const g of mine) {
    const file = `${g.id}.ics`;
    keep.add(file);
    await fs.writeFile(path.join(ROOT, "ics", file), calendar([event(g, cfg, ovr)], cfg, cfg.team.displayName), "utf8");
  }
  for (const f of await fs.readdir(path.join(ROOT, "ics"))) if (f.endsWith(".ics") && !keep.has(f)) await fs.unlink(path.join(ROOT, "ics", f));
  await fs.writeFile(path.join(ROOT, "season.ics"), calendar(mine.map((g) => event(g, cfg, ovr)), cfg, `${cfg.team.displayName} | משחקים`), "utf8");
  console.log(`built season.ics + ${mine.length} game files`);
}

module.exports = { buildIcs };
if (require.main === module) buildIcs().catch((e) => { console.error(e); process.exit(1); });
