<div align="center">

# Self-Control Tracker

**A privacy-first streak & habit tracker for breaking unwanted habits**
Relapse logging · Trigger analysis · Mood journal · AI deep analysis · Urge help · Cross-device sync

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
- ⚠️ **Relapse logging** — time (backdate any moment) / trigger tags / severity / whether porn was involved / notes; everything editable & deletable
- 📝 **Mood journal** — minute-precision daily notes to catch emotional shifts before they escalate
- 📅 **Unified timeline** — journal, relapses and AI interventions side by side per day

### Insights
- 📊 **Statistics** — weekly/monthly counts with week-over-week comparison, longest streak, 12-week & 6-month trend charts
- 🎯 **Trigger analysis** — top triggers ranking, time-of-day distribution, porn-involvement ratio
- 🤖 **AI deep analysis** (optional) — powered by DeepSeek, **generated only when you click**: the window automatically covers everything since your last analysis, and it remembers previous sessions like an ongoing conversation
- 🆘 **Urge help** (optional) — pick your state (active urge / drifting / just relapsed / calm) and get matched intervention; supports multi-turn follow-up

### Positive reinforcement
- 🏆 **Achievements** — 7 / 14 / 21 / 35 / 84 / 183 / 365-day milestones, unlocked by all-time best streak, never reset by a relapse
- 🌤️ **Stage tips** — physical and psychological expectations that shift with your streak

### Sync & privacy
- ☁️ **Cross-device sync** (optional) — access-code based, no account needed; share one dataset between phone and desktop
- 🔒 **Privacy first** — collects nothing; in offline mode data lives only in your browser
- 💾 **Data ownership** — one-click JSON export / import (export includes a time-sorted unified timeline)

## 🧠 Evidence-based design

| Feature | Backed by |
|---------|-----------|
| Streak timer & relapse log | Self-monitoring: tracking a behavior alone changes it |
| Urge-help state routing | Urges peak and fade within 3–7 minutes; action before analysis, low-shame framing |
| Non-judgmental AI tone | Shame amplifies relapse cycles; self-compassion works better |
| Achievement system | Positive reinforcement & self-efficacy: making invisible persistence visible |

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

## 🤖 AI coach setup (optional)

Supports **DeepSeek** or **Gemini** — both expose OpenAI-compatible APIs, so switching is config-only:

| Env var | Notes |
|---|---|
| `DEEPSEEK_API_KEY` | from [platform.deepseek.com](https://platform.deepseek.com), very cheap |
| `GEMINI_API_KEY` | from [aistudio.google.com](https://aistudio.google.com), has a free tier |
| `AI_PROVIDER` | optional: `deepseek` / `gemini` / `auto` (default auto: prefers Gemini when its key exists) |
| `AI_MODEL` | optional: override the default model name |

1. Provide the key(s) as environment secrets
2. Deploy the Worker in `ai-report/` (**no cron** — it only serves manual requests)
3. Analysis is generated only when you tap "Let AI analyze"; the window covers everything since your last analysis

If the preferred provider fails, the other one is tried automatically.

> ⚠️ **Privacy note**: Gemini's *free tier* falls under Google's "Unpaid Services" terms, which state that your data is used to improve their products, and ask you not to submit sensitive or personal information. This app's data is highly sensitive — prefer the paid tier or a different provider if that matters to you.

Everything else works fine without it.

## 🔧 Deploying your own instance

The frontend is fully static — host it anywhere. The server endpoints in `functions/api/`
use standard Request/Response semantics and can be adapted to major serverless platforms
(Vercel, Netlify, Cloudflare Pages, …) with minimal changes. See `ai-report/` for the AI service.

## 📁 Project structure

```
self-control-tracker/
├── index.html              # markup
├── styles.css              # dark theme
├── app.js                  # app logic (data / stats / charts / sync)
├── server.js               # local static server (optional)
├── tools/                  # helper scripts (smoke test / history analysis)
├── functions/api/
│   ├── sync.js             # sync API (conflict-safe merging)
│   ├── generate-report.js  # AI manual analysis (proxy)
│   └── help.js             # urge help (proxy)
├── ai-report/
│   └── worker.js           # AI analysis + urge help service (DeepSeek)
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
