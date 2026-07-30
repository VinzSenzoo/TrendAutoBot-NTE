# TrendBTC Auto Bot

Node.js bot for TrendBTC: auto tasks, Trend Box, and BTC 5m auto predict.

## Features

- Multi account (`account.json`)
- Proxy support (`proxy.txt`)
- Auto refresh token
- Auto complete tasks (skip `X_FOLLOW`)
- Auto open Trend Box (free 12h + tickets)
- BTC 5m multi-signal predict
- TUI dashboard (blessed)

## Setup

```bash
npm install
copy account.example.json account.json
```

Edit `account.json`:

```json
[
  {
    "access_token": "...",
    "refresh_token": "...",
    "stake_min": 50,
    "stake_max": 100
  }
]
```

Optional proxy:

```bash
copy proxy.example.txt proxy.txt
```

## Run

```bash
npm start
```

Dry run:

```bash
npm run dry
```

## Keys

| Key | Action |
|-----|--------|
| `←` `→` | Switch account |
| `B` | Set random stake popup |
| `Q` / `Esc` | Quit (or close popup if open) |

## Notes

- `bot.js` is **exclusive** and is not published in this repository. You need the main bot file locally to run (`npm start`).
- Do **not** commit `account.json`, `token.txt`, or `proxy.txt` (secrets).
- X_FOLLOW tasks are skipped (manual verify).
- Delay 5–10s between tasks/box opens (except last).
