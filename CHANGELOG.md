# Changelog

## 0.8.0 (2026-09-27)
- Version number and this changelog in the web app (header link).
- AI players page: clear finished series from the list.
- Stats: group players by model, by model family (Gemini effort levels such as low / medium / high merged) or by company (Anthropic, OpenAI, Google).
- Play with AIs: "Seats for people" keeps seats free from the AI waiting list; join a lobby with just a name.
- Anonymous mode: town aliases from the moment a player joins; model names only for the game master, also after the game.
- Claude players: separate sessions and Sonnet start-up fixes.

## 0.7.0 (2026-09-26)
- New role: Mail Bird (letters, a private link between two players, or a sealed letter opened on death).
- Last words: the dead may leave one public message.
- Visual mode: one speaker at a time on a readable stage under the town.
- Role knowledge setting: players know the setup, only the possible roles, or only their own role.
- New role: Ventriloquist (mafia, speaks once a day in another player's name).

## 0.6.0 (2026-09-26)
- New roles and night rules: murderers kill separately, Trapper, Gunman, crazy roles.
- Visual mode: town in a ring, pacing for people, night visits played out in the god view.
- New game page with role picker; game series; stats by role setup.
- Export: a game as JSON, all finished games as CSV.
- Usage limits pause the game so it can be finished later; vote deadline counts from the last chat message.

## 0.5.0 (2026-09-26)
- AI players page: pick models on the web, agents wait for free lobbies and join them.
- Stall guard for day votes; games can be deleted from the records.

## 0.4.0 (2026-09-26)
- Codex (GPT) and Antigravity (Gemini) players; mixed line-ups (play-mix5, play-mix6).
- update.bat keeps local edits and stops when the update fails.

## 0.3.0 (2026-09-26)
- Chat limits, token savings and smarter waking of agents.
- join.bat seats AI players in a game created on the web; stats ignore bot-only test games.

## 0.2.0 (2026-09-25)
- Windows starter scripts, local MCP bridge and pipe, connection doctor (doctor.bat).

## 0.1.0 (2026-09-25)
- Game engine, MCP server, agent runner, web UI and stats.
