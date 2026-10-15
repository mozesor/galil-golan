// Reads our team's fixture list from the Israel Football Association site (football.org.il).
// ONE does not publish venues; the IFA page does, and it also shows the kickoff time once it is set.
// One page request per run. Returns [{date:"YYYY-MM-DD", home, away, venue|null, time:"HH:MM"|null}].
const UA = "Mozilla/5.0 (compatible; galil-golan-darom parents site; +https://mozesor.github.io/galil-golan/)";

const decode = (s) => String(s)
  .replace(/&quot;|&#34;/g, '"').replace(/&#39;|&#039;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
const cell = (html) => decode(html.replace(/<span class="sr-only">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

async function fetchIfaGames(teamId, seasonId) {
  const url = `https://www.football.org.il/team-details/team-games/?team_id=${teamId}&season_id=${seasonId}`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow" });
  if (!res.ok) throw new Error(`IFA HTTP ${res.status}`);
  const html = await res.text();
  const zone = html.split('class="table_row_group"')[1] || "";
  const rows = [];
  for (const m of zone.matchAll(/<a class="table_row[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const cols = [...m[1].matchAll(/<div class="table_col[^"]*">([\s\S]*?)<\/div>/g)].map((c) => cell(c[1]));
    if (cols.length < 4) continue;
    const [d, match, venue, time] = cols;
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
    const sep = match.indexOf(" - ");
    if (!dm || sep < 0) continue;
    const t = /^(\d{1,2}):(\d{2})$/.exec(time || "");
    rows.push({
      date: `${dm[3]}-${dm[2]}-${dm[1]}`,
      home: match.slice(0, sep).trim(),
      away: match.slice(sep + 3).trim(),
      venue: venue || null,
      time: t && !(t[1] === "00" && t[2] === "00") ? `${t[1].padStart(2, "0")}:${t[2]}` : null, // 00:00 = not set yet
    });
  }
  if (!rows.length) throw new Error("IFA page had no game rows (layout changed?)");
  return rows;
}

const norm = (s) => String(s || "").replace(/["״'׳]/g, "").replace(/צו פיוס/g, "").replace(/\s+/g, " ").trim();

// Attach {date,time,venue} from IFA to each of our games. Matches on both team names; falls back to a unique date.
function attachIfa(games, rows, isOurs) {
  let matched = 0;
  for (const g of games.filter(isOurs)) {
    const h = norm(g.home.name), a = norm(g.away.name);
    let r = rows.find((x) => norm(x.home) === h && norm(x.away) === a);
    if (!r) {
      const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(g.date));
      const same = rows.filter((x) => x.date === iso);
      if (same.length === 1) r = same[0];
    }
    if (r) { g.ifa = { date: r.date, time: r.time, venue: r.venue }; matched++; }
  }
  return matched;
}

module.exports = { fetchIfaGames, attachIfa, norm };
