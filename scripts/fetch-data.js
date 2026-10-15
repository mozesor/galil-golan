// Fetches league games + standings from ONE (vole.one.co.il) and writes ../data.json
// No dependencies. Node 20+ (built-in fetch).
const fs = require("fs/promises");
const path = require("path");
const { buildIcs } = require("./build-ics");
const { fetchIfaGames, attachIfa } = require("./ifa");

const ROOT = path.join(__dirname, "..");
const CONFIG = require(path.join(ROOT, "config.json"));
const LEAGUE_ID = CONFIG.leagueId;
const BASE = "https://vole.one.co.il";
const ROUNDS_API = `${BASE}/api/leagues/rounds?league_id=${LEAGUE_ID}`;
const STANDINGS_API = `${BASE}/api/leagues/standings?league_id=${LEAGUE_ID}`;

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json,text/plain,*/*",
      referer: `${BASE}/league/${LEAGUE_ID}`,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url} | ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const games = (j) => (Array.isArray(j) ? j : Array.isArray(j?.games) ? j.games : []);

function cleanName(s) {
  if (!s) return "";
  // ONE names carry stray quotes like  מ.כ קרית חיים "שמשון
  return String(s).replace(/["״]/g, "").replace(/\s+/g, " ").trim();
}

function normTeam(side) {
  const t = side?.team || {};
  return {
    id: t._id ?? null,
    pid: t.provider?.id ?? null,
    name: cleanName(t.provider?.name ?? t.one?.name),
  };
}

function normGoal(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeGame(g) {
  const hg = normGoal(g?.home?.goals);
  const ag = normGoal(g?.away?.goals);
  return {
    id: g?._id ?? null,
    date: g?.date ?? null,
    round: (g?.round?.number ?? 0) + 1,
    finished: !!g?.is_finished || (hg !== null && ag !== null),
    home: { ...normTeam(g?.home), goals: hg },
    away: { ...normTeam(g?.away), goals: ag },
  };
}

async function main() {
  const base = await fetchJson(ROUNDS_API);
  const league = base?.league || {};
  const maxRound = 60;
  const all = [];
  let emptyStreak = 0;
  for (let n = 0; n <= maxRound; n++) {
    try {
      const j = await fetchJson(`${ROUNDS_API}&round=${n}`);
      const gs = games(j);
      if (!gs.length) {
        emptyStreak++;
        if (emptyStreak >= 5 && all.length) break;
      } else {
        emptyStreak = 0;
        all.push(...gs.map(normalizeGame));
      }
      await new Promise((r) => setTimeout(r, 100));
    } catch (e) {
      console.warn("round", n, String(e));
    }
  }

  const byId = new Map();
  for (const g of all) if (g.id) byId.set(g.id, g);
  const list = Array.from(byId.values()).sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  let standings = [];
  try {
    const st = await fetchJson(STANDINGS_API);
    const group = st?.standings?.[0];
    standings = (group?.teams || []).map((t, i) => ({
      rank: i + 1,
      id: t._id ?? null,
      name: cleanName(t.one?.name),
      games: t.stats?.games ?? 0,
      wins: t.stats?.wins ?? 0,
      draws: t.stats?.draws ?? 0,
      losses: t.stats?.losses ?? 0,
      gf: t.stats?.goals?.for ?? 0,
      ga: t.stats?.goals?.against ?? 0,
      gd: t.stats?.goals?.difference ?? 0,
      points: t.stats?.points ?? 0,
    }));
  } catch (e) {
    console.warn("standings failed:", String(e));
  }

  // IFA: venue + kickoff time for our games (ONE does not publish venues)
  let previous0 = null;
  try { previous0 = JSON.parse(await fs.readFile(path.join(ROOT, "data.json"), "utf8")); } catch {}
  const ours = (g) => g.home.name.includes(CONFIG.team.match) || g.away.name.includes(CONFIG.team.match);
  const ourPid = list.find(ours) ? (list.find(ours).home.name.includes(CONFIG.team.match) ? list.find(ours).home.pid : list.find(ours).away.pid) : null;
  const ifaTeam = CONFIG.ifa?.teamId || ourPid;
  const season = base?.games?.[0]?.season_id || CONFIG.ifa?.seasonId || 28;
  try {
    const rows = await fetchIfaGames(ifaTeam, season);
    const n = attachIfa(list, rows, ours);
    console.log(`IFA: ${rows.length} rows, matched ${n} of our games`);
  } catch (e) {
    console.warn("IFA fetch failed, keeping previous IFA data:", String(e));
    const prev = new Map((previous0?.games || []).filter((g) => g.ifa).map((g) => [g.id, g.ifa]));
    for (const g of list) if (prev.has(g.id)) g.ifa = prev.get(g.id);
  }

  const teams = new Map();
  for (const g of list) for (const s of ["home", "away"]) teams.set(g[s].id, g[s].name);

  let previous = null;
  try { previous = JSON.parse(await fs.readFile(path.join(ROOT, "data.json"), "utf8")); } catch {}
  const prevCount = previous?.games?.length || 0;
  if (!list.length || (prevCount && list.length < prevCount * 0.8)) {
    throw new Error(`refusing to write data.json: fetched ${list.length} games, previous file has ${prevCount}`);
  }
  if (!standings.length && previous?.standings?.length) standings = previous.standings;

  const out = {
    league: {
      id: LEAGUE_ID,
      name: cleanName(league?.name) || CONFIG.leagueName || "",
      currentRound: league?.round?.number ?? null,
    },
    fetchedAt: new Date().toISOString(),
    teams: Array.from(teams, ([id, name]) => ({ id, name })),
    games: list,
    standings,
  };

  // keep the old timestamp when nothing but the clock changed, so the workflow's "commit if changed" guard works
  const strip = (o) => JSON.stringify({ ...o, fetchedAt: null });
  if (previous && strip(previous) === strip(out)) {
    console.log("no changes since", previous.fetchedAt);
    await buildIcs(); // overrides.json may have changed even when ONE did not
    return;
  }
  await fs.writeFile(path.join(ROOT, "data.json"), JSON.stringify(out, null, 2), "utf8");
  console.log(`saved data.json: ${list.length} games, ${standings.length} teams in table, round ${out.league.currentRound}`);
  await buildIcs();
}

main().catch((e) => {
  console.error("fetch failed:", e);
  process.exit(1);
});
