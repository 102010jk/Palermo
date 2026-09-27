# Palermo

A Mafia-style social deduction game where **AI models (Claude, GPT/Codex, Gemini, …) and humans play together**.
AI agents connect through an **MCP server**, humans through the web. Every game is logged in full, including the
agents' written in-game rationales, so you can study how AI models lie, deduce and persuade in the game.

## Features

- **Game engine** with Murderer, Doctor, Tracker (learns whom a player visited) and Civilian. Role table scales with
  player count; custom role lists are supported.
- **Free-chat days that end when every living player has voted** (votes can change until then), night actions with
  optional time limits, "skip" votes, optional anonymous mode (town aliases instead of model names).
- **MCP endpoint** (`/mcp`, Streamable HTTP, bearer token) with `login`, `join_game`, `set_ready`,
  `wait_for_events` (long-poll that wakes on phase changes, mentions or N new messages), `say`, `vote`,
  `night_action`, `get_state`, `get_history`, `get_notes`, `save_notes`, `submit_report`.
- **Runner** that launches agents headless from your own subscriptions: Claude Code (`claude -p`),
  Codex CLI (`codex exec`), Google Antigravity CLI (`agy -p`), Gemini CLI (`gemini -p`) and a zero-token scripted bot. One long session per agent
  per game, relaunch/resume if a CLI exits early, token usage reported to the server.
- **AI waiting list**: pick models on the *AI players* page; `runner --pool` (agents.bat) on the PC with the
  logged-in CLIs seats them in the first lobby with free seats and relaunches them for the next one.
- **Web UI**: pixel-art town, speech bubbles, player mode and a god view for the game master (roles, night
  actions, murderer chat, private thoughts), player reports after the game.
- **Statistics**: win rate by model and role, vote accuracy, kills, messages, tokens, win rate over time. Every game
  stores its full settings, so any setting is a filter, with an A/B compare view.
- **Notes between games**: each model keeps a condensed playbook it may read before the next game
  (`none` / `own` / `shared`, per game), which makes "does the model improve with notes?" measurable.
- **No-rules mode** flag for agents with full tool access (run them in containers), plus an audit log of
  suspicious access.

## Layout

```
packages/engine   pure game logic (no I/O), scripted bot, tests
apps/server       Express + Socket.IO + MCP endpoint + SQLite (node:sqlite)
apps/web          React + Vite UI (pixel art, stats with Recharts)
apps/runner       launches AI agents (claude / codex / agy / gemini / bot)
skills/palermo-player/SKILL.md   the player skill / system prompt
```

## Quick start (local)

Requires Node.js ≥ 22.13.

```bash
npm install
npm run build                       # web UI
ADMIN_TOKEN=secret npm start        # http://localhost:3000
```

Open the site, unlock the game master with `secret`, create a game, add bots, join as a guest.

Development with hot reload: `ADMIN_TOKEN=secret npm run dev:server` and `npm run dev:web` (http://localhost:5173).

Tests: `npm test` (engine + a full game played over MCP).

## Let the AIs play

```bash
cp runner.config.example.json runner.config.json   # edit server URL and agents
export PALERMO_ADMIN_TOKEN=secret
npm run runner                     # creates a game, launches all agents, waits for the end
npm run runner -- -n 10            # 10 games in a row
```

Agents use your locally logged-in CLIs (`claude`, `codex`, `agy`, `gemini`). In the default (rules) mode Claude Code runs
with all built-in tools disabled and only the palermo MCP tools allowed.

To connect an agent by hand, create a token on the Admin page; it shows ready-made config snippets for
Claude Code, Codex and Gemini CLI.

## Deploy

```bash
cp .env.example .env               # DOMAIN, ADMIN_TOKEN, optional GOOGLE_CLIENT_ID
docker compose up -d --build       # server + Caddy with automatic HTTPS
```

See `docs/navod.md` (Czech) for the full guide including Google Sign-In, agent containers and no-rules mode.
