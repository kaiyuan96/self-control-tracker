<div align="center">

# Self-Control Tracker

**A privacy-first streak & habit tracker for breaking unwanted habits**
Relapse logging · Trigger analysis · If-Then coping plans · AI weekly coach · Cross-device sync

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-f7df1e)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Offline First](https://img.shields.io/badge/offline-first-blue)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4)

English | [简体中文](./README.md)

</div>

---

**Self-Control Tracker** is a zero-dependency single-page web app for anyone quitting a habit
they want to break — pornography, compulsive masturbation, doomscrolling, or any behavior
where a visible streak and honest tracking help. It covers the full loop of
**log → analyze → plan → review**, making it a great fit for NoFap-style streak tracking,
dopamine detox challenges, and relapse-prevention routines.

> No sign-up · No account · Your data stays yours

## ✨ Features

### Core tracking
- ⏱️ **Live streak timer** — days clean, precise to the second
- ⚠️ **Relapse logging** — time (backdate any moment) / trigger tags / severity / notes; everything editable & deletable
- 📝 **Mood journal** — minute-precision daily notes to catch emotional shifts before they escalate

### Insights
- 📊 **Statistics** — weekly/monthly counts with week-over-week comparison, longest streak, 12-week & 6-month trend charts
- 🎯 **Trigger analysis** — top triggers ranking, time-of-day distribution (early morning / morning / afternoon / night)
- 🤖 **AI weekly coach** (optional) — powered by DeepSeek; every week it reads your relapse details, journal entries and their time-order, then writes a personal analysis with concrete suggestions

### Behavior-change tools
- 🛡️ **If-Then plans** — built on the *Implementation Intentions* research ("If situation X, I will do Y"): decide in advance instead of white-knuckling in the moment; AI can draft candidate plans from your high-risk windows and top triggers
- 🔄 **Relapse review loop** — after each relapse, log whether a plan was executed; the data flows back so plans keep improving

### Sync & privacy
- ☁️ **Cross-device sync** (optional) — access-code based, no account needed; share one dataset between phone and desktop
- 🔒 **Privacy first** — collects nothing; in offline mode data lives only in your browser
- 💾 **Data ownership** — one-click JSON export / import

## 🧠 Evidence-based design

| Feature | Backed by |
|---------|-----------|
| Streak timer & relapse log | Self-monitoring: tracking a behavior alone changes it |
| If-Then plans | Implementation Intentions (Gollwitzer & Sheeran meta-analysis, d≈0.65) |
| Plan review loop | Relapse Prevention: situation-coping training |
| Non-judgmental AI tone | Shame amplifies relapse cycles; self-compassion works better |

## 🚀 Getting started

```bash
git clone https://github.com/kaiyuan96/self-control-tracker.git
cd self-control-tracker
node server.js
# open http://localhost:8765
```

Or simply open `index.html` in a browser for the offline-only mode
(everything works except cloud sync).

No build step, no `npm install` — the whole project is 3 static files plus 2 lightweight APIs.

## ☁️ Cloud sync (optional)

1. Open **Settings → Cloud Sync → Generate access code** (8 characters, e.g. `K7D2-9F4M`)
2. Enter the code on any other device to link them
3. All changes sync automatically from then on

Architecture: static frontend + a `/api/sync` endpoint + SQLite storage.
Your access code is the key to your data — keep it safe.

## 🤖 AI weekly coach setup (optional)

Bring your own DeepSeek API key ([platform.deepseek.com](https://platform.deepseek.com), very cheap):

1. Provide it as the environment secret `DEEPSEEK_API_KEY`
2. Deploy the scheduled task in `ai-report/` (runs every Monday morning by default)
3. Users can also tap "Regenerate AI analysis" in-app anytime

Everything else works fine without it.

## 🔧 Deploying your own instance

The frontend is fully static — host it anywhere. The server endpoints in `functions/api/`
use standard Request/Response semantics and can be adapted to major serverless platforms
(Vercel, Netlify, Cloudflare Pages, …) with minimal changes. See `ai-report/` for the
scheduled analysis job.

## 📁 Project structure

```
self-control-tracker/
├── index.html              # markup
├── styles.css              # dark theme
├── app.js                  # app logic (data / stats / charts / sync)
├── server.js               # local static server (optional)
├── functions/api/
│   ├── sync.js             # sync API (conflict-safe merging)
│   ├── generate-report.js  # AI weekly report (proxy)
│   └── suggest-plan.js     # AI plan suggestions (proxy)
├── ai-report/
│   └── worker.js           # scheduled AI analysis job (cron)
└── LICENSE
```

## 🔒 Privacy

- The app itself **collects nothing**; offline data lives only in localStorage
- With cloud sync enabled, data goes to *your* deployed database, readable/writable only with the access code
- When the AI coach is enabled, relevant content is sent to the model provider you configured
- Keep cloud backups safe — they contain your private records

## 🤝 Contributing

Issues and PRs are welcome! Please make sure the core flow (log → stats → sync) still works before submitting.

## 📄 License

[MIT](./LICENSE)
