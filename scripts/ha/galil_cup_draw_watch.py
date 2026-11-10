#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
10/11/2026: מעקב אחרי הגרלות הגביע, רץ מהבית (Home Assistant, shell_command) כמה פעמים ביום.

הסוכן בענן לא יכול לגשת ל-ONE, ואתר ג׳וניורליג חוסם גישה אוטומטית בכוונה, אז הבית בודק ב-ONE בלבד:
  1. ה-API של המשחקים: לכל גביע, הסיבוב הראשון שעדיין ריק. ברגע שמופיעים בו משחקים, ההגרלה פורסמה.
     מדווח על המשחק שלנו (אם כבר ידוע) ועל מספר המשחקים.
  2. פיד ה-RSS הכללי של ONE (כ-50 כתבות אחרונות): כותרת עם "הגרל" ועם גביע/נוער/ילדים/נערים,
     למשל "נקבע מועד להגרלת גביע המדינה לנוער ולילדים". כך ההודעה המוקדמת על מועד ההגרלה מגיעה מיד.
כל דבר מדווח פעם אחת בלבד. המצב נשמר בקובץ JSON (ברירת מחדל /config/.galil_draw_watch.json).
בריצה הראשונה (אין קובץ מצב) רק נרשם המצב הנוכחי, בלי דיווח.

שימוש:  python3 galil_cup_draw_watch.py [--state PATH] [--dry]
פלט: שורת JSON אחת: {"new": [שורות לדיווח], "watch": {...}}. תלוי רק בספרייה הסטנדרטית.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from html import unescape

CUPS = [
    {"id": 1306, "name": "גביע ילדים ב׳", "ours": "גליל גולן", "site": "https://mozesor.github.io/galil-golan/"},
    {"id": 1304, "name": "גביע ילדים ג׳ (הפועל פ״ת)", "ours": "הפועל פ\"ת צפון", "site": "https://mozesor.github.io/hapoel-pt-tzafon/"},
]
RSS_URL = "https://www.one.co.il/rss"
UA = "Mozilla/5.0 (compatible; galil-golan-darom parents site; +https://mozesor.github.io/galil-golan/)"
LETTERS = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח"]
DRY = "--dry" in sys.argv
STATE = sys.argv[sys.argv.index("--state") + 1] if "--state" in sys.argv else "/config/.galil_draw_watch.json"


def http(url, accept="application/json"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def one_round(cup_id, idx):
    return (json.loads(http(f"https://vole.one.co.il/api/leagues/rounds?league_id={cup_id}&round={idx}")).get("games") or [])


def local_date(iso_utc):
    d = datetime.fromisoformat(iso_utc.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=2)))
    # ONE כותב חצות מקומית (22:00Z בחורף, 21:00Z בקיץ) כשאין שעה
    if d.hour in (0, 1) and d.minute == 0:
        return d.strftime("%d/%m"), None
    d = datetime.fromisoformat(iso_utc.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=2)))
    return d.strftime("%d/%m"), d.strftime("%H:%M")


def round_name(idx):
    return f"סיבוב {LETTERS[idx]}׳" if idx < len(LETTERS) else f"סיבוב {idx + 1}"


def check_cups(state, out):
    for cup in CUPS:
        key = str(cup["id"])
        known = state["rounds"].get(key)   # הסיבוב האחרון (אינדקס) שבו ראינו משחקים
        start = 0 if known is None else known + 1
        idx = start
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
                    date, time = local_date(g["date"])
                    where = "בבית" if cup["ours"] in h else "בחוץ"
                    opp = a if cup["ours"] in h else h
                    ours = f'שלנו: {opp} {where}, {date}' + (f' {time}' if time else "")
                else:
                    ours = "הקבוצה שלנו לא ברשימה (אולי המשחק שלנו עוד לא נטען)"
                out["new"].append(f'🏆 {cup["name"]}: ההגרלה של {round_name(idx)} פורסמה ב-ONE ({len(games)} משחקים). {ours}.')
            state["rounds"][key] = idx
            idx += 1
        out["watch"][cup["name"]] = round_name(state["rounds"].get(key, -1) + 1) + " (ממתין)"


def check_rss(state, out):
    try:
        xml = http(RSS_URL, accept="application/rss+xml")
    except Exception as e:
        out["errors"].append(f"RSS של ONE לא עונה ({e})")
        return
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
        if link in seen:
            continue
        if "הגרל" in title and re.search(r"גביע|נוער|ילדים|נערים", title) and not re.search(r"אלופות|אירופה|קונפרנס|ליגה האירופית|מונדיאל|וינר|ווינר", title):
            if state.get("initialized"):
                out["new"].append(f"🗓️ ONE: {title} {link}")
    # שומרים את כל הכתבות שבפיד עכשיו, כדי שכתבה ישנה שנשארת בפיד לא תדווח שוב
    state["rss"] = list(dict.fromkeys(fresh + [s for s in state["rss"] if s not in fresh]))[:300]


def main():
    state = {"rounds": {}, "rss": [], "initialized": False}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            state.update(json.load(f))
    out = {"new": [], "errors": [], "watch": {}, "checked": datetime.now().strftime("%d/%m %H:%M")}
    check_cups(state, out)
    check_rss(state, out)
    if not state["initialized"]:
        out["new"] = []   # ריצה ראשונה: רק לרשום את המצב הנוכחי
        state["initialized"] = True
    if not DRY:
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
