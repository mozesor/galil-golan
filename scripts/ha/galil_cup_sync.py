#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
28/10/2026: גשר בין אתר ההתאחדות לאתרי ההורים של גליל גולן (דרום + צפון).
08/11/2026: גם אתר שלישי, הפועל פ"ת צפון ילדים ג׳ (גביע ילדים ג׳, national_cup_id=592). לכל אתר מזהה גביע משלו.

ההתאחדות מפרסמת הגרלות גביע (ושעות/מגרשים) ימים לפני ש-ONE טוען אותן, ואתר ההתאחדות
חוסם את שרתי GitHub. הסקריפט רץ מהבית (Home Assistant, shell_command) פעמיים ביום:
  1. מושך את דף גביע ילדים ב׳ (הסיבוב הנוכחי) מאתר ההתאחדות.
  2. לכל אתר: משחקים שלנו שעדיין לא קיימים ב-data.json (מ-ONE) נכתבים ל-overrides.json
     כ-extraGames דרך GitHub Contents API. ה-workflow של המאגר נדלק על הדחיפה, בונה את האתר
     ושולח להורים התראת "הגרלת הגביע". כש-ONE טוען את המשחק, fetch-data.js מוחק את הרשומה.
  3. רשומה ידנית שכבר קיימת מתעדכנת אם ההתאחדות פרסמה שעה או מגרש.
  4. משחק ש-ONE כבר מכיר: שעה/מגרש/תאריך מההתאחדות נכתבים ל-overrides.games[<id>] (האתר, היומן וההתראות מכבדים אותם).
  6. 12/11/2026: תוצאות הגביע. דף הגביע בהתאחדות מציג את כל משחקי הסיבוב עם תוצאה, הארכה ובעיטות הכרעה.
     ONE מאחר לפעמים בימים (או מזין ידנית), אז התוצאות הרשמיות נכתבות ל-overrides.cupIfa[<סיבוב>]
     ו-fetch-data.js ממזג אותן לרשימת "כל משחקי הגביע" ומסמן תוצאה שההתאחדות עוד לא אישרה.
  5. 09/11/2026: גם משחקי ליגה. דף המשחקים של הקבוצה בהתאחדות (team-details/team-games) נותן תאריך/שעה/מגרש
     לכל המשחקים הקרובים; ONE מציג אותם עד אז כ"שבת 00:00". אותו מנגנון של סעיף 4.

שימוש:  python3 galil_cup_sync.py [--dry] [--token TOKEN]
הטוקן: --token, או משתנה הסביבה GITHUB_GALIL_TOKEN, או github_galil_token מתוך /config/secrets.yaml.
פלט: שורת JSON אחת (לשימוש ב-response_variable של Home Assistant).
תלוי רק בספרייה הסטנדרטית של פייתון.
"""
import base64
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import date, timedelta
from html import unescape

CUP_URL = "https://www.football.org.il/national-cup/?national_cup_id={cup}&season_id=28"   # 591 ילדים ב׳, 592 ילדים ג׳
TEAM_URL = "https://www.football.org.il/team-details/team-games/?team_id={team}&season_id=28"
UA = "Mozilla/5.0 (compatible; galil-golan-darom parents site; +https://mozesor.github.io/galil-golan/)"
SITES = [
    {"name": "דרום", "repo": "mozesor/galil-golan", "team": 8657, "cup": 591},
    {"name": "צפון", "repo": "mozesor/galil-golan-tzafon", "team": 3674, "cup": 591},
    {"name": "הפועל פ\"ת", "repo": "mozesor/hapoel-pt-tzafon", "team": 6174, "cup": 592},
    # 13/11/2026: ילדים ג׳ של גליל גולן. בלי גביע באתר (cup None): רק שעות, מגרשים ותאריכים של משחקי הליגה מדף הקבוצה.
    {"name": "דרום ג׳", "repo": "mozesor/galil-golan-darom-gimel", "team": 3675, "cup": None},
    {"name": "צפון ג׳", "repo": "mozesor/galil-golan-tzafon-gimel", "team": 8526, "cup": None},
]
ONE_CUP = {591: 1306, 592: 1304}   # מזהה הגביע ב-ONE, לבדיקת הכיוון של עמודת התוצאה
ONE_URL = "https://vole.one.co.il/api/leagues/rounds?league_id={lid}&round={rnd}"
RESULTS = {}      # cup_id → תוצאות הסיבוב הנוכחי מדף הגביע
RESULTS_OK = {}   # cup_id → (תקין, הסבר) מבדיקת הכיוון
LETTERS = {1: "א", 2: "ב", 3: "ג", 4: "ד", 5: "ה", 6: "ו", 7: "ז", 8: "ח", 9: "ט", 10: "י"}
DRY = "--dry" in sys.argv


def http(url, data=None, token=None, method=None, accept="text/html"):
    headers = {"User-Agent": UA, "Accept": accept}
    if token:
        headers["Authorization"] = "Bearer " + token
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def get_token():
    if "--token" in sys.argv:
        return sys.argv[sys.argv.index("--token") + 1]
    if os.environ.get("GITHUB_GALIL_TOKEN"):
        return os.environ["GITHUB_GALIL_TOKEN"]
    for p in ("/config/secrets.yaml",):
        try:
            with open(p, encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"^\s*github_galil_token\s*:\s*(.+?)\s*$", line)
                    if m:
                        return m.group(1).strip().strip('"').strip("'")
        except OSError:
            pass
    return None


def clean(s):
    s = unescape(s)
    s = re.sub(r"<span class=.sr-only.>[^<]*</span>", "", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("\xa0", " ")
    s = re.sub(r"\s*[\"״]?צו פיוס[\"״]?\s*$", "", s)   # הסיומת "צו פיוס" לא חלק מהשם
    s = re.sub(r"[\"״]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def pair(txt):
    m = re.search(r"(\d+)\s*-\s*(\d+)", txt or "")
    return (int(m.group(2)), int(m.group(1))) if m else None   # בדף ההתאחדות המספר הראשון הוא של האורחת


def parse_results(html):
    """כל משחקי הסיבוב מדף הגביע: {"<בית>-<חוץ>": "h:a" / "h:a et h:a" / "h:a et h:a pk h:a" / ""}. מחרוזת ריקה = אין עדיין תוצאה."""
    res = {}
    for part in re.split(r"<(?:a|div) class=['\"]table_row", html)[1:]:
        t = re.search(r"^[^>]*?data-team1='(-?\d+)' data-team2='(-?\d+)'", part)
        if not t:
            continue
        h, a = int(t.group(1)), int(t.group(2))
        if h < 0 or a < 0:
            continue
        cols = re.findall(r"<div class='table_col[^']*'>(.*?)</div>", part, re.S)
        if len(cols) < 7:
            continue
        txt = [re.sub(r"<span class=.sr-only.>[^<]*</span>", "", c) for c in cols]
        r, et, pk = pair(txt[4]), pair(txt[5]), pair(txt[6])
        if not r:
            res[f"{h}-{a}"] = ""
            continue
        v = f"{r[0]}:{r[1]}"
        if et:
            v += f" et {et[0]}:{et[1]}"
        if pk:
            v += f" pk {pk[0]}:{pk[1]}"
        res[f"{h}-{a}"] = v
    return res


def check_orientation(cup_id, round_no, results):
    """משווה מול ONE: אם רוב התוצאות הלא-שוות יוצאות הפוכות, מבנה הדף השתנה ואסור לכתוב. מחזיר (תקין, הסבר)."""
    try:
        one = json.loads(http(ONE_URL.format(lid=ONE_CUP[cup_id], rnd=round_no - 1), accept="application/json")).get("games") or []
    except Exception as e:  # noqa
        return False, f"ONE לא זמין לבדיקת כיוון: {e}"
    same = flipped = 0
    for g in one:
        hg, ag = g["home"].get("goals"), g["away"].get("goals")
        v = results.get(f"{g['home']['team']['provider']['id']}-{g['away']['team']['provider']['id']}")
        if not v or hg is None or ag is None or hg < 0 or ag < 0 or hg == ag:
            continue
        ih, ia = (int(x) for x in v.split(" ")[0].split(":"))
        if (ih, ia) == (hg, ag):
            same += 1
        elif (ih, ia) == (ag, hg):
            flipped += 1
    if same + flipped < 4:
        return False, f"אין מספיק משחקים להשוואה מול ONE ({same + flipped})"
    if flipped > same:
        return False, f"עמודת התוצאה בהתאחדות נראית הפוכה ({flipped} הפוכות, {same} תואמות)"
    return True, f"{same} תואמות, {flipped} הפוכות"


def fetch_ifa(cup_id):
    html = http(CUP_URL.format(cup=cup_id))
    RESULTS[cup_id] = parse_results(html)
    m = re.search(r"id='ddlRoundsLabel'>\s*מחזור\s+(\d+)", html)
    round_no = int(m.group(1)) if m else 0
    rows = []
    for part in re.split(r'<div class="table_row ?"', html)[1:]:
        t = re.match(r"\s*data-team1='(-?\d+)' data-team2='(-?\d+)'", part)
        if not t:
            continue
        cols = re.findall(r"<div class='table_col[^']*'>(.*?)</div>", part.split("new-desktop-only")[0], re.S)
        if len(cols) < 4:
            continue
        d = re.search(r"(\d{2})/(\d{2})/(\d{4})", cols[0])
        if not d:
            continue
        names = re.findall(r'<span class="team-name-text">(.*?)</span>', cols[1], re.S)
        if len(names) != 2:
            continue
        home = clean(re.sub(r"(&nbsp;|\s)*-\s*$", "", unescape(names[0])))
        away = clean(names[1])
        venue = clean(cols[2])
        tm = clean(cols[3])
        tm = tm if re.match(r"^\d{1,2}:\d{2}$", tm) and tm != "00:00" else ""
        rows.append({
            "home_id": int(t.group(1)), "away_id": int(t.group(2)),
            "date": f"{d.group(3)}-{d.group(2)}-{d.group(1)}",
            "home": home, "away": away, "venue": venue, "time": tm,
        })
    return round_no, rows


def fetch_team(team_id):
    """כל משחקי הקבוצה העונה מדף ההתאחדות (ליגה וגביע), בלי מזהי קבוצות."""
    html = http(TEAM_URL.format(team=team_id))
    rows = []
    for part in re.findall(r'<a class="table_row[^"]*"[^>]*>(.*?)</a>', html, re.S):
        cols = [clean(c) for c in re.findall(r"<div class=\"table_col[^\"]*\">(.*?)</div>", part, re.S)]
        if len(cols) < 4:
            continue
        d = re.search(r"(\d{2})/(\d{2})/(\d{4})", cols[0])
        teams = re.split(r"\s+-\s+", cols[1], maxsplit=1)
        if not d or len(teams) != 2:
            continue
        tm = cols[3] if re.match(r"^\d{1,2}:\d{2}$", cols[3]) and cols[3] != "00:00" else ""
        rows.append({"date": f"{d.group(3)}-{d.group(2)}-{d.group(1)}", "home": clean(teams[0]), "away": clean(teams[1]),
                     "venue": cols[2], "time": tm, "result": cols[4] if len(cols) > 4 else ""})
    return rows


def apply_ifa(games_ovr, one, r, label, out):
    """שעה/מגרש/תאריך מההתאחדות → overrides.games[<one id>]. מחזיר True אם השתנה משהו."""
    cur = games_ovr.get(one["id"]) or {}
    upd = {}
    if r["time"] and r["time"] != (cur.get("time") or "") and r["time"] != one_local_time(one["date"]):
        upd["time"] = r["time"]   # רק אם ONE עצמו עוד לא מציג את השעה הזו
    if r["venue"] and r["venue"] != (cur.get("venue") or ""):
        upd["venue"] = r["venue"]
    # תאריך: רק כשההתאחדות שונה מ-ONE (ONE מציג את התאריך המתוכנן עם 00:00 עד שמעדכנים)
    if r["date"] != one_local_date(one["date"]) and r["date"] != cur.get("date"):
        upd["date"] = r["date"]
    elif r["date"] == one_local_date(one["date"]) and cur.get("date"):
        upd["date"] = None   # ONE התיישר, אין צורך בדריסה
    if not upd:
        out["skipped"].append(label + " (כבר ב-ONE)")
        return False
    cur.update(upd)
    games_ovr[one["id"]] = {k: v for k, v in cur.items() if v}
    out["updated"].append(label + " (ONE) " + json.dumps(upd, ensure_ascii=False))
    return True


def one_local_date(iso_utc):
    """תאריך מקומי (ישראל) של timestamp מ-ONE. ONE כותב 22:00Z (חורף) / 21:00Z (קיץ) = חצות מקומית של היום הבא."""
    from datetime import datetime, timezone
    dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00")).astimezone(timezone.utc)
    off = 2 if (dt.month < 3 or dt.month > 10) else 3   # קירוב מספיק לתאריך (שעון חורף/קיץ)
    return (dt + timedelta(hours=off)).date().isoformat()


def one_local_time(iso_utc):
    """שעה מקומית HH:MM של timestamp מ-ONE, או "" כשאין שעה (00:00)."""
    from datetime import datetime, timezone
    dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00")).astimezone(timezone.utc)
    off = 2 if (dt.month < 3 or dt.month > 10) else 3
    t = (dt + timedelta(hours=off)).strftime("%H:%M")
    return "" if t == "00:00" else t


def near(a, b, days=10):
    return abs(date.fromisoformat(a) - date.fromisoformat(b)) <= timedelta(days=days)


def core(n):
    s = clean(n or "")
    pref = r"^(?:מ\.כ\.?|מ\.ס\.?|ה\.|מועדון הכדורגל|מועדון כדורגל|מרכז קהילתי|איחוד|הפועל|הפ'|הפ׳|מכבי|בית\"ר|בית״ר|ביתר|בני|עירוני|צעירי|מ\.א\.?)\s*"
    for _ in range(5):
        t = re.sub(pref, "", s).strip()
        if t == s or not t:
            break
        s = t
    return s


def sync_site(site, round_no, rows, token, team_rows=None):
    ours = [r for r in rows if site["team"] in (r["home_id"], r["away_id"])]
    out = {"site": site["name"], "ifa_games": len(ours), "added": [], "updated": [], "skipped": []}
    cup_res = RESULTS.get(site["cup"]) if RESULTS_OK.get(site["cup"], (False,))[0] else None
    if not ours and not team_rows and not cup_res:
        return out
    data = json.loads(http(f"https://raw.githubusercontent.com/{site['repo']}/main/data.json", accept="application/json"))
    api = f"https://api.github.com/repos/{site['repo']}/contents/overrides.json"
    meta = json.loads(http(api, token=token, accept="application/vnd.github+json"))
    ovr = json.loads(base64.b64decode(meta["content"]).decode("utf-8"))
    extras = ovr.get("extraGames") or []
    games_ovr = ovr.setdefault("games", {})
    one_games = [g for g in (data.get("cup") or {}).get("games", []) if not g.get("manual")]
    changed = False
    # תוצאות הגביע מההתאחדות. תוצאה שכבר נרשמה לא נמחקת (רק מתעדכנת), כדי שתקלה רגעית בדף לא תעלים תוצאות מהאתר.
    if cup_res and round_no:
        store = ovr.setdefault("cupIfa", {})
        cur = dict(store.get(str(round_no)) or {})
        new = dict(cur)
        for k, v in cup_res.items():
            if v or k not in new:
                new[k] = v
        if new != cur:
            store[str(round_no)] = new
            changed = True
            out["results"] = len([k for k in new if new[k] and new[k] != cur.get(k)])
    for r in ours:
        opp_id = r["away_id"] if r["home_id"] == site["team"] else r["home_id"]
        opp = r["away"] if r["home_id"] == site["team"] else r["home"]
        label = f"{r['date']} {r['home']} - {r['away']}"
        if opp_id < 0:
            out["skipped"].append(label + " (יריבה עוד לא ידועה)")
            continue
        # ONE כבר מכיר את המשחק → לא מוסיפים רשומה ידנית, אבל כן מסנכרנים תאריך/שעה/מגרש מההתאחדות
        # לתוך overrides.games[<id>] (ONE לא מפרסם מגרש, ולפעמים מציג תאריך ישן בלי שעה; GitHub חסום באתר ההתאחדות).
        one = next((g for g in one_games if near(g["date"][:10], r["date"]) and (opp_id in (g["home"].get("pid"), g["away"].get("pid")) or core(opp) in (core(g["home"]["name"]), core(g["away"]["name"])))), None)
        if one:
            if apply_ifa(games_ovr, one, r, label, out):
                changed = True
            continue
        ex = next((x for x in extras if x.get("cup") and x.get("date") and near(x["date"], r["date"]) and core(opp) in (core(x.get("home")), core(x.get("away")))), None)
        if ex:
            upd = {}
            if r["time"] and r["time"] != (ex.get("time") or ""):
                upd["time"] = r["time"]
            if r["venue"] and r["venue"] != (ex.get("venue") or ""):
                upd["venue"] = r["venue"]
            if r["date"] != ex.get("date"):
                upd["date"] = r["date"]
            if upd:
                ex.update(upd)
                changed = True
                out["updated"].append(label + " " + json.dumps(upd, ensure_ascii=False))
            else:
                out["skipped"].append(label + " (כבר באתר)")
            continue
        extras.append({
            "id": f"manual-cup-r{round_no}-{r['date']}",
            "cup": True,
            "roundName": f"סיבוב {LETTERS.get(round_no, round_no)}",
            "round": round_no,
            "date": r["date"],
            "home": r["home"],
            "away": r["away"],
            "time": r["time"],
            "venue": r["venue"],
            "note": f"לפי אתר ההתאחדות. {'השעה והמגרש יפורסמו בהמשך.' if not r['time'] else ''}".strip(),
        })
        changed = True
        out["added"].append(label + (f" {r['time']}" if r["time"] else "") + (f" ({r['venue']})" if r["venue"] else ""))
    # משחקי ליגה קרובים: שעה/מגרש/תאריך מדף הקבוצה בהתאחדות
    if team_rows:
        today = date.today().isoformat()
        league = [g for g in data.get("games", []) if not g.get("cup") and not g.get("manual") and not g.get("finished")]
        for r in team_rows:
            if r["date"] < today or r["result"]:
                continue   # גם שורה בלי שעה ומגרש חשובה: התאריך עצמו יכול לזוז (כרמיאל: 14.11 → 21.11)
            label = f"{r['date']} {r['home']} - {r['away']}"
            # עד 10 ימים הפרש מהתאריך המתוכנן ב-ONE: משחק שנדחה בשבוע עדיין נתפס, המשחק החוזר (סבב שני) רחוק הרבה יותר
            one = next((g for g in league if near(g["date"][:10], r["date"], 10) and
                        {core(r["home"]), core(r["away"])} == {core(g["home"]["name"]), core(g["away"]["name"])}), None)
            if not one:
                continue   # כנראה משחק גביע (טופל למעלה) או משחק ש-ONE עוד לא מכיר
            if apply_ifa(games_ovr, one, r, label, out):
                changed = True
    if changed and not DRY:
        ovr["extraGames"] = extras
        body = json.dumps(ovr, ensure_ascii=False, indent=2) + "\n"
        http(api, token=token, method="PUT", accept="application/vnd.github+json", data={
            "message": "עדכון מאתר ההתאחדות: שעות ומגרשים (אוטומטי מהבית)",
            "content": base64.b64encode(body.encode("utf-8")).decode("ascii"),
            "sha": meta["sha"],
        })
        out["pushed"] = True
    elif changed:
        out["pushed"] = False
        out["dry"] = True
    return out


def main():
    token = None if DRY else get_token()
    if not DRY and not token:
        print(json.dumps({"error": "no token"}, ensure_ascii=False))
        return 2
    # כל גביע נמשך פעם אחת, גם אם כמה אתרים משתמשים בו
    cups = {}
    for cup_id in sorted({s["cup"] for s in SITES if s["cup"]}):
        try:
            cups[cup_id] = fetch_ifa(cup_id)
        except Exception as e:  # noqa
            cups[cup_id] = e
    if all(isinstance(v, Exception) for v in cups.values()):
        print(json.dumps({"error": "ifa: " + "; ".join(str(v) for v in cups.values())}, ensure_ascii=False))
        return 1
    res = {"rounds": {str(k): v[0] for k, v in cups.items() if not isinstance(v, Exception)}, "rows": sum(len(v[1]) for v in cups.values() if not isinstance(v, Exception)), "sites": []}
    for s in SITES:
        c = cups[s["cup"]] if s["cup"] else (0, [])
        if isinstance(c, Exception):
            res["sites"].append({"site": s["name"], "error": f"ifa: {c}"})
            continue
        try:
            team_rows = fetch_team(s["team"])
        except Exception as e:  # noqa
            team_rows = None
            res.setdefault("warnings", []).append(f"{s['name']}: team page: {e}")
        if s["cup"] and s["cup"] not in RESULTS_OK:
            RESULTS_OK[s["cup"]] = check_orientation(s["cup"], c[0], RESULTS.get(s["cup"]) or {}) if c[0] else (False, "מספר הסיבוב לא נמצא בדף")
            if not RESULTS_OK[s["cup"]][0]:
                res.setdefault("warnings", []).append(f"תוצאות גביע {s['cup']} לא נכתבו: {RESULTS_OK[s['cup']][1]}")
        try:
            res["sites"].append(sync_site(s, c[0], c[1], token, team_rows))
        except Exception as e:  # noqa
            res["sites"].append({"site": s["name"], "error": str(e)})
    res["changes"] = sum(len(x.get("added", [])) + len(x.get("updated", [])) for x in res["sites"])
    print(json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
