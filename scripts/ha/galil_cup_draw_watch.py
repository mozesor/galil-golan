#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
10/11/2026: מעקב אחרי הגרלות הגביע, רץ מהבית (Home Assistant, shell_command) חמש פעמים ביום.

הסוכן בענן לא יכול לגשת ל-ONE ולהתאחדות, ואתר ג׳וניורליג חוסם גישה אוטומטית בכוונה. הבית בודק:
  1. ONE, ה-API של המשחקים: לכל גביע, הסיבוב הראשון שעדיין ריק. ברגע שמופיעים בו משחקים, ההגרלה ב-ONE.
  2. ONE, פיד ה-RSS הכללי (כ-50 כתבות אחרונות): כותרת עם "הגרל" ועם גביע/נוער/ילדים/נערים,
     למשל "נקבע מועד להגרלת גביע המדינה לנוער ולילדים". כך ההודעה המוקדמת על מועד ההגרלה מגיעה מיד.
  3. ההתאחדות, דף הגביע: מספר הסיבוב הנוכחי ("מחזור N"). ההתאחדות מפרסמת ימים לפני ONE.
     כשהסיבוב עולה: ההגרלה פורסמה. מדווח את השורה שלנו אם היא כבר עם שם (ולא "מנצחת במשחק N").
  4. ההתאחדות, המגזין (20 כתבות אחרונות): כותרת עם "הגרל" וגביע/נוער/ילדים/נערים,
     למשל "תוצאות הגרלת גביע המדינה: טרום א' ועד נערים א'" (28/10/2026, יום ההגרלה).
כל דבר מדווח פעם אחת בלבד. המצב נשמר בקובץ JSON (ברירת מחדל /config/.galil_draw_watch.json).
חלק שעדיין אין לו מצב שמור (ריצה ראשונה) רק נרשם, בלי דיווח.

שימוש:  python3 galil_cup_draw_watch.py [--state PATH] [--dry]
פלט: שורת JSON אחת: {"new": [שורות לדיווח], "errors": [...], "watch": {...}}. תלוי רק בספרייה הסטנדרטית.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from html import unescape

CUPS = [
    {"id": 1306, "ifa": 591, "name": "גביע ילדים ב׳", "ours": "גליל גולן", "teams": {8657: "דרום", 3674: "צפון"}},
    {"id": 1304, "ifa": 592, "name": "גביע ילדים ג׳ (הפועל פ״ת)", "ours": "הפועל פ\"ת צפון", "teams": {6174: "הפועל פ\"ת"}},
]
RSS_URL = "https://www.one.co.il/rss"
IFA = "https://www.football.org.il"
CUP_URL = IFA + "/national-cup/?national_cup_id={cup}&season_id=28"
NEWS_URL = IFA + "/?catid=%7B526A3A51-4A27-44B9-9B03-1C65259E1451%7D"   # מגזין ההתאחדות, 20 כתבות אחרונות
UA = "Mozilla/5.0 (compatible; galil-golan-darom parents site; +https://mozesor.github.io/galil-golan/)"
LETTERS = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח"]
DRAW_RE = re.compile(r"הגרל")
YOUTH_RE = re.compile(r"גביע|נוער|ילדים|נערים|שנתונ")
NOT_RE = re.compile(r"אלופות|אירופה|קונפרנס|מונדיאל|וינר|ווינר|נבחרת")   # גביע הבוגרים ואירופה לא מעניינים
DRY = "--dry" in sys.argv
STATE = sys.argv[sys.argv.index("--state") + 1] if "--state" in sys.argv else "/config/.galil_draw_watch.json"


def http(url, accept="application/json"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "ignore")


def one_round(cup_id, idx):
    return (json.loads(http(f"https://vole.one.co.il/api/leagues/rounds?league_id={cup_id}&round={idx}")).get("games") or [])


def local_dt(iso_utc):
    """תאריך ושעה מקומיים (ישראל) מ-timestamp של ONE. חצות מקומית = אין שעה."""
    d = datetime.fromisoformat(iso_utc.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=2)))
    if d.hour in (0, 1) and d.minute == 0:
        return d.strftime("%d/%m"), None
    return d.strftime("%d/%m"), d.strftime("%H:%M")


def round_name(idx):
    return f"סיבוב {LETTERS[idx]}׳" if 0 <= idx < len(LETTERS) else f"סיבוב {idx + 1}"


def is_draw_title(title):
    return bool(DRAW_RE.search(title) and YOUTH_RE.search(title) and not NOT_RE.search(title))


# ---------- ONE ----------
def check_one_rounds(state, out):
    for cup in CUPS:
        key = str(cup["id"])
        known = state["rounds"].get(key)   # הסיבוב האחרון (אינדקס) שבו ראינו משחקים
        idx = 0 if known is None else known + 1
        while idx < 8:
            try:
                games = one_round(cup["id"], idx)
            except Exception as e:
                out["errors"].append(f'{cup["name"]}: ONE לא עונה ({e})')
                break
            if not games:
                break
            if known is not None:
                mine = [g for g in games if cup["ours"] in g["home"]["team"]["provider"]["name"] + g["away"]["team"]["provider"]["name"]]
                if mine:
                    g = mine[0]
                    h, a = g["home"]["team"]["provider"]["name"], g["away"]["team"]["provider"]["name"]
                    date, time = local_dt(g["date"])
                    home = cup["ours"] in h
                    ours = f'שלנו: {a if home else h} {"בבית" if home else "בחוץ"}, {date}' + (f" {time}" if time else "")
                else:
                    ours = "הקבוצה שלנו לא ברשימה (אולי המשחק שלנו עוד לא נטען)"
                out["new"].append(f'🏆 ONE, {cup["name"]}: ההגרלה של {round_name(idx)} פורסמה ({len(games)} משחקים). {ours}.')
            state["rounds"][key] = idx
            idx += 1
        out["watch"][f'ONE {cup["name"]}'] = round_name(state["rounds"].get(key, -1) + 1) + " (ממתין)"


def check_one_rss(state, out):
    try:
        xml = http(RSS_URL, accept="application/rss+xml")
    except Exception as e:
        out["errors"].append(f"RSS של ONE לא עונה ({e})")
        return
    first = not state["rss"]
    seen = set(state["rss"])
    fresh = []
    for item in re.findall(r"<item>(.*?)</item>", xml, re.S):
        t = re.search(r"<title>(.*?)</title>", item, re.S)
        l = re.search(r"<link>(.*?)</link>", item, re.S)
        if not t or not l:
            continue
        title = unescape(re.sub(r"<!\[CDATA\[|\]\]>", "", t.group(1))).strip()
        link = l.group(1).strip().split("?")[0]
        fresh.append(link)
        if link not in seen and not first and is_draw_title(title):
            out["new"].append(f"🗓️ ONE: {title} {link}")
    # שומרים את כל הכתבות שבפיד עכשיו, כדי שכתבה שנשארת בפיד לא תדווח שוב
    state["rss"] = list(dict.fromkeys(fresh + [s for s in state["rss"] if s not in fresh]))[:300]


# ---------- ההתאחדות ----------
def clean(s):
    s = unescape(s)
    s = re.sub(r"<span class=.sr-only.>[^<]*</span>", "", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("\xa0", " ")
    s = re.sub(r"\s*[\"״]?צו פיוס[\"״]?\s*$", "", s)
    s = re.sub(r"[\"״]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def fetch_ifa_cup(cup_id):
    """(מספר הסיבוב הנוכחי, שורות הסיבוב). אותו פענוח כמו ב-galil_cup_sync.py."""
    html = http(CUP_URL.format(cup=cup_id), accept="text/html")
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
        names = re.findall(r'<span class="team-name-text">(.*?)</span>', cols[1], re.S)
        if not d or len(names) != 2:
            continue
        home = clean(re.sub(r"(&nbsp;|\s)*-\s*$", "", unescape(names[0])))
        rows.append({"home_id": int(t.group(1)), "away_id": int(t.group(2)), "date": f"{d.group(1)}/{d.group(2)}",
                     "home": home, "away": clean(names[1]), "venue": clean(cols[2]), "time": clean(cols[3])})
    return round_no, rows


def check_ifa_rounds(state, out):
    ifa = state.setdefault("ifa_rounds", {})
    for cup in CUPS:
        key = str(cup["ifa"])
        try:
            round_no, rows = fetch_ifa_cup(cup["ifa"])
        except Exception as e:
            out["errors"].append(f'{cup["name"]}: ההתאחדות לא עונה ({e})')
            continue
        if not round_no:
            out["errors"].append(f'{cup["name"]}: לא נמצא מספר סיבוב בדף ההתאחדות')
            continue
        known = ifa.get(key)
        if known is not None and round_no > known:
            ours = []
            for r in rows:
                for tid, label in cup["teams"].items():
                    if tid in (r["home_id"], r["away_id"]):
                        home = r["home_id"] == tid
                        opp = r["away"] if home else r["home"]
                        tm = f' {r["time"]}' if re.match(r"^\d{1,2}:\d{2}$", r["time"]) and r["time"] != "00:00" else ""
                        ours.append(f'{label}: {opp} {"בבית" if home else "בחוץ"}, {r["date"]}{tm}')
            txt = "; ".join(ours) if ours else 'השורה שלנו עדיין בלי שם (כנראה "מנצחת במשחק"), תתעדכן בהמשך'
            out["new"].append(f'🏆 ההתאחדות, {cup["name"]}: פורסם {round_name(round_no - 1)} ({len(rows)} משחקים). {txt}. {CUP_URL.format(cup=cup["ifa"])}')
        ifa[key] = round_no
        out["watch"][f'ההתאחדות {cup["name"]}'] = f"{round_name(round_no - 1)} פורסם, ממתין ל{round_name(round_no)}"


def check_ifa_news(state, out):
    try:
        html = http(NEWS_URL, accept="text/html")
    except Exception as e:
        out["errors"].append(f"מגזין ההתאחדות לא עונה ({e})")
        return
    first = "ifa_news" not in state
    seen = set(state.get("ifa_news", []))
    fresh = []
    for href, title, date in re.findall(r'<article class="thumb">.*?<a class="thumb_link" href="([^"]+)".*?<h2>(.*?)</h2>.*?<span>(\d{2}/\d{2}/\d{2})</span>', html, re.S):
        title = clean(title)
        link = IFA + unescape(href)
        fresh.append(link)
        if link not in seen and not first and is_draw_title(title):
            out["new"].append(f"🗓️ ההתאחדות ({date}): {title} {link}")
    if not fresh and not first:
        out["errors"].append("מגזין ההתאחדות: לא נמצאו כתבות בדף (המבנה השתנה?)")
        return
    state["ifa_news"] = list(dict.fromkeys(fresh + [s for s in seen if s not in fresh]))[:200]


def main():
    state = {"rounds": {}, "rss": [], "initialized": False}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            state.update(json.load(f))
    out = {"new": [], "errors": [], "watch": {}, "checked": datetime.now().strftime("%d/%m %H:%M")}
    check_one_rounds(state, out)
    check_one_rss(state, out)
    check_ifa_rounds(state, out)
    check_ifa_news(state, out)
    if not state["initialized"]:
        out["new"] = []   # ריצה ראשונה: רק לרשום את המצב הנוכחי
        state["initialized"] = True
    if not DRY:
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
