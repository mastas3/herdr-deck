# Go to market: Agent Session Archive

## Landing page

# כל ההיסטוריה של הסוכנים שלך, במקום אחד שאפשר לחפש בו

מריץ Claude Code, Codex ו-Cursor במקביל על פיצ'רים שונים? Agent Session Archive שומר כל קריאת כלי, החלטה וקוד שהם כתבו, ומאפשר לך לחפש ולשחזר כל סשן — גם אם היה לפני שבועיים על מכונה אחרת.

- חיפוש טקסט חופשי על כל ההחלטות וההסבר מאחוריהן — לא צריך לגרוף לוגים גולמיים
- שחזור סשן שלם צעד-אחר-צעד: קריאות כלים, דיפים וקוד, בסדר הכרונולוגי הנכון
- דוח שבועי במייל עם ההחלטות המרכזיות של כל הסוכנים שלך, בפרויקט-פרויקט

**נסה עכשיו — הרשמה חינם, $19 לחודש אחרי תקופת ניסיון**

## Pricing

- **Solo — $19/month**: 1 machine watched; Unlimited Claude Code + Codex sessions archived; Full-text search and replay; Weekly digest email
- **Multi-machine — $39/month**: Up to 3 machines watched with unified search; Everything in Solo; Export sessions as JSON or Markdown, unlimited
- **Team — $89/month**: Up to 10 machines / 5 developers; Shared searchable archive across the team; Priority support for adding new agent log formats (e.g. Cursor)

## Launch posts (post them yourself)

### Show HN

I run Claude Code, Codex, and sometimes Gemini in parallel on different features, and two weeks later I could never find the decision an agent made or why it picked a specific architecture. Built a small daemon (stasclaw-based) that tails Claude Code's logs and Codex's session output, dumps everything into SQLite with full-text search, and gives you a replay view of any past session — tool calls, decisions, diffs, in order. Local-first, single machine for now, $19/month if you want the hosted dashboard + weekly digest, but the core watcher is something you can run yourself. Would love feedback on what log formats to support next (Cursor is on the list).

### r/ClaudeAI

Anyone else lose track of what their agent actually decided a week ago? I run Claude Code and Codex on separate worktrees for different features and kept losing the thread on why a specific approach was chosen. Ended up building a tool that watches the logs, stores everything in SQLite, and lets me search/replay any old session. Sharing here because a few threads this month mentioned the exact same pain with worktrees getting unmanageable. Happy to give early access to a couple of people who are hitting this daily — just comment or DM.

### r/ChatGPTCoding

If you're running multiple coding agents at once (Claude Code + Codex here), you know the logs pile up fast and finding a specific decision from last week is basically impossible. I built a local daemon that archives every tool call and decision into a searchable SQLite database with a replay UI. Still early, single machine only for now, but it's already saved me from re-deriving a decision I made 10 days ago. If this is a pain for you too, I'm looking for a few people to try it before I open it up more broadly.

## First-10 outreach (send it yourself; nothing is sent automatically)

היי, ראיתי את הפוסט שלך על ניהול Claude Code / Codex / Gemini במקביל עם worktrees ו-tmux — ממש הזדהיתי, יש לי בדיוק את אותה בעיה. בניתי כלי קטן שסורק את הלוגים של הסוכנים ושומר כל החלטה, diff וקריאת כלי במסד SQLite שאפשר לחפש בו ולשחזר סשנים ישנים. עדיין בשלב מוקדם (מכונה אחת בינתיים), אבל זה כבר חוסך לי חיפוש בלוגים גולמיים. אם זה כאב שאתה מכיר, אשמח לתת לך גישה מוקדמת בחינם בתמורה לפידבק — פשוט תגיד לי ואני שולח לינק.
