#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
28/10/2026: גשר בין אתר ההתאחדות לאתרי ההורים של גליל גולן (דרום + צפון).

ההתאחדות מפרסמת הגרלות גביע (ושעות/מגרשים) ימים לפני ש-ONE טוען אותן, ואתר ההתאחדות
חוסם את שרתי GitHub. הסקריפט רץ מהבית (Home Assistant, shell_command) פעמיים ביום:
  1. מושך את דף גביע ילדים ב׳ (הסיבוב הנוכחי) מאתר ההתאחדות.
  2. לכל אתר: משחקים שלנו שעדיין לא קיימים ב-data.json (מ-ONE) נכתבים ל-overrides.json
     כ-extraGames דרך GitHub Contents API. ה-workflow של המאגר נדלק על הדחיפה, בונה את האתר
     ושולח להורים התראת "הגרלת הגביע". כש-ONE טוען את המשחק, fetch-data.js מוחק את הרשומה.
  3. רשומה ידנית שכבר קיימת מתעדכנת אם ההתאחדות פרסמה שעה או מגרש.

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

CUP_URL = "https://www.football.org.il/national-cup/?national_cup_id=591&season_id=28"
UA = "Mozilla/5.0 (compatible; galil-golan-darom parents site; +https://mozesor.github.io/galil-golan/)"
SITES = [
    {"name": "דרום", "repo": "mozesor/galil-golan", "team": 8657},
    {"name": "צפון", "repo": "mozesor/galil-golan-tzafon", "team": 3674},
]
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


def fetch_ifa():
    html = http(CUP_URL)
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


def sync_site(site, round_no, rows, token):
    ours = [r for r in rows if site["team"] in (r["home_id"], r["away_id"])]
    out = {"site": site["name"], "ifa_games": len(ours), "added": [], "updated": [], "skipped": []}
    if not ours:
        return out
    data = json.loads(http(f"https://raw.githubusercontent.com/{site['repo']}/main/data.json", accept="application/json"))
    api = f"https://api.github.com/repos/{site['repo']}/contents/overrides.json"
    meta = json.loads(http(api, token=token, accept="application/vnd.github+json"))
    ovr = json.loads(base64.b64decode(meta["content"]).decode("utf-8"))
    extras = ovr.get("extraGames") or []
    one_games = [g for g in (data.get("cup") or {}).get("games", []) if not g.get("manual")]
    changed = False
    for r in ours:
        opp_id = r["away_id"] if r["home_id"] == site["team"] else r["home_id"]
        opp = r["away"] if r["home_id"] == site["team"] else r["home"]
        label = f"{r['date']} {r['home']} - {r['away']}"
        if opp_id < 0:
            out["skipped"].append(label + " (יריבה עוד לא ידועה)")
            continue
        # ONE כבר מכיר את המשחק → אין מה להוסיף (fetch-data.js מוחק רשומות ידניות כאלה בעצמו)
        if any(near(g["date"][:10], r["date"]) and (opp_id in (g["home"].get("pid"), g["away"].get("pid")) or core(opp) in (core(g["home"]["name"]), core(g["away"]["name"]))) for g in one_games):
            out["skipped"].append(label + " (כבר ב-ONE)")
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
    if changed and not DRY:
        ovr["extraGames"] = extras
        body = json.dumps(ovr, ensure_ascii=False, indent=2) + "\n"
        http(api, token=token, method="PUT", accept="application/vnd.github+json", data={
            "message": "גביע: עדכון מאתר ההתאחדות (אוטומטי מהבית)",
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
    try:
        round_no, rows = fetch_ifa()
    except Exception as e:  # noqa
        print(json.dumps({"error": f"ifa: {e}"}, ensure_ascii=False))
        return 1
    res = {"round": round_no, "rows": len(rows), "sites": []}
    for s in SITES:
        try:
            res["sites"].append(sync_site(s, round_no, rows, token))
        except Exception as e:  # noqa
            res["sites"].append({"site": s["name"], "error": str(e)})
    res["changes"] = sum(len(x.get("added", [])) + len(x.get("updated", [])) for x in res["sites"])
    print(json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
