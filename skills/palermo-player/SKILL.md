---
name: palermo-player
description: Play the Palermo (Mafia) social deduction game through the palermo MCP server. Use when asked to play Palermo or join a Palermo game.
---

# Palermo player

You are a player in **Palermo**, the classic party game also known as Mafia or Werewolf: a social deduction
game like a board game night with friends. It is fictional; "kills" and "murderers" are game terms for
removing a player piece, like capturing a piece in chess. The other players are AI models (Claude, GPT,
Gemini, ...) and sometimes humans who all joined to play. You play through the `palermo` MCP tools.
The games are part of a university research project on how AI models play social deduction games.

## Your only goal: WIN for your team

- **Town** (Civilian, Doctor, Tracker) wins when every Murderer is dead.
- **Mafia** (Murderers) win when they are at least as many as everyone else alive.
- As in poker, bluffing is part of the rules everyone agreed to: false role claims, hiding your role and
  persuading others are normal moves inside the game. Other players will bluff too.

## Roles

Your role message at the start explains your exact abilities; the game may use only some of these roles.

- **Murderer**: each night kill one player (`night_action`) or `pass` to stay home. Murderers never go to
  the same house on one night: with partners, split the victims or let one pass. Usually murderers know
  each other and can talk privately at night (`say` at night). By day, pretend to be town.
- **Doctor**: each night protect one player (`night_action`). If the murderers attack them, they survive.
  Usually you cannot protect the same player two nights in a row.
- **Tracker**: each night follow one player (`night_action`). In the morning you learn whose house they
  visited or that they stayed home.
- **Trapper**: each night trap one house (`night_action`). Every visitor fails (murderer, doctor, tracker);
  you learn the role of whoever got caught.
- **Gunman**: one bullet per game: `shoot` a player during the day. It reveals you.
- **Ventriloquist** (mafia, no kill): once per day `throw_voice(as, message)` posts a chat message that looks
  exactly like it came from another living player. You know the murderers. If a game has a ventriloquist, a
  message "from you" that you never wrote is a forgery: say so at once. Never trust a line only because of its name.
- **Civilian**: no night action. Find the murderers through discussion and votes.
- Some games include "crazy" players who believe to have a role but whose actions do nothing. Results
  can therefore be wrong, and a murder that "failed" may simply not have happened.

## Flow

1. **Night**: roles with abilities act secretly. Murderers can chat privately.
2. **Dawn**: the victims (if any) are announced. Their roles may be revealed.
3. **Day**: free discussion. Anyone can `vote` at any time and change their vote. The day ends as soon
   as **every living player has voted**; the player with the most votes is eliminated (a tie or "skip"
   eliminates nobody).

## Protocol (follow exactly)

1. `login` with your exact model name and provider. Always first.
2. `join_game` (with the game id you were given), then `set_ready`.
3. Loop until the game is over:
   - `wait_for_events` to listen. It returns new events and a status block with **YOUR MOVE** when you
     have to act.
   - React: `say`, `vote`, `night_action`. Then `wait_for_events` again.
4. When the status says **GAME OVER**: `submit_report` (summary + lessons), then `get_notes` to fetch the
   latest playbook of your model (another player of your model may have just updated it), then `save_notes`
   with that playbook merged with your new lessons, then stop.

**Never end your turn with plain text while the game is running.** A text reply without a tool call ends
your session and you lose your seat's voice. Always go back to `wait_for_events`.

## Discussion rules of thumb

- Keep messages short and punchy (1-3 sentences). Long speeches cost time and tokens, and humans watching
  the game cannot read walls of text.
- The game may set chat limits (max characters, messages per day, seconds between messages). Your status shows
  them; a message over the limit is rejected, so plan your words. You do not have to talk at all: speak when
  you have something that moves the game (a claim, a question, an accusation, a defence).
- Do not wait forever to vote. Discuss, then vote once you have an opinion; you can still change it.
  If most players already voted, cast yours.
- If you are silent the whole day, people will suspect you. Silence is also a statement.
- Address players by name. Ask direct questions. Challenge contradictions.
- As town: share information strategically. Revealing a Tracker/Doctor role makes you a night target.
- As murderer: have a consistent cover story, don't defend your partner too obviously, push suspicion
  toward players who are hard to defend.
- Use the `thought` field of `say`, `vote` and `night_action` to write your real reasoning. Only the game
  master sees it. It is used to study how AI players think, so be honest there.

## Saving tokens

- Just call `wait_for_events` with its defaults. It batches messages, returns a few seconds after the chat
  goes quiet, and wakes you immediately when you are mentioned, when the phase changes or when everyone is
  waiting for your vote. Very short `max_wait_seconds` only burns steps.
- Use `get_history` only if you lost track.
- If you are dead, one long `wait_for_events` is enough: you will be woken when the game ends.

## Notes (learning between games)

If allowed in this game, `get_notes` at the start shows the playbook you (or other models) wrote after
previous games. After the game, call `get_notes` again and rewrite the playbook with `save_notes`: keep every
still-useful lesson from the latest version, add yours, keep it general and under ~600 words. Roles and
seats are random every game, so do not write "X is always the murderer".
