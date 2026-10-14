# גליל גולן דרום | ילדים ב'

אתר להורים של הקבוצה: המשחק הבא, תוצאות, טבלה, יומן, ומידע על היריבות.
הנתונים נמשכים אוטומטית מאתר ONE (ליגה 1247, ליגת ילדים ב' מפרץ) כל 30 דקות.

## מה יש כאן

| קובץ | תפקיד |
|---|---|
| `index.html` | האתר עצמו. קובץ אחד, בלי תלויות, עובד כאפליקציה בטלפון |
| `admin.html` | ממשק ניהול: שעות, מגרשים, ניווט והערות להורים. שומר ישירות ל-GitHub |
| `data.json` | המשחקים והטבלה. מתעדכן אוטומטית, לא לערוך ידנית |
| `config.json` | שם הקבוצה, מזהה הליגה וכותרת האתר |
| `overrides.json` | המידע הידני שממשק הניהול שומר |
| `scripts/fetch-data.js` | הסקריפט שמושך את הנתונים מ-ONE |
| `.github/workflows/update-data.yml` | ההרצה האוטומטית ב-GitHub Actions |

## העלאה לאוויר (פעם אחת)

1. ליצור מאגר חדש ב-GitHub ולהעלות את כל התיקייה.
2. Settings > Pages > Deploy from a branch > `main` / root.
3. Settings > Actions > General > Workflow permissions > Read and write permissions.
4. Actions > Update data.json > Run workflow (הרצה ראשונה ידנית).

האתר יהיה בכתובת `https://<שם-משתמש>.github.io/<שם-המאגר>/`.
את הקישור הזה שולחים לקבוצת ההורים. בטלפון: שיתוף > הוספה למסך הבית.

## ממשק הניהול

פותחים את `admin.html` באותה כתובת. בפעם הראשונה צריך:

1. GitHub > Settings > Developer settings > Fine-grained tokens > Generate new token.
2. Repository access: רק המאגר הזה. Permissions: Contents = Read and write, Actions = Read and write.
3. להדביק את הטוקן בממשק. הוא נשמר רק בדפדפן של מי שהדביק אותו.

כל שמירה יוצרת commit, והאתר מתעדכן תוך כדקה.

## בדיקה מקומית

לא לפתוח את `index.html` בלחיצה כפולה (הדפדפן חוסם קריאת JSON מ-file://). במקום זה:

```powershell
python -m http.server 8000
```

ואז http://localhost:8000

משיכת נתונים ידנית מהמחשב:

```powershell
node scripts/fetch-data.js
```
