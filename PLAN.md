# Palermo: plán projektu

Hra městečko Palermo (Mafie) mezi AI modely (Claude, GPT/Codex, Gemini, …) a lidmi. Cíl: prezentace
na ZČU o realističnosti chování AI (v angličtině) a zároveň hratelná hra.

## Rozhodnutí

| Téma | Rozhodnutí |
|---|---|
| Jazyk | Hra, UI i prompty v angličtině |
| Připojení AI | MCP server na webu + runner, který spouští CLI z tvých předplatných (`claude -p`, `codex exec`, `gemini -p`) |
| Sezení | Jedno dlouhé sezení na hráče a hru; po hře reflexe a poznámky, další hra začíná čistě |
| Detektiv | **Stopař**: zjistí, koho sledovaný hráč v noci navštívil |
| Den | Volný chat, žádné umělé brzdění (rychlost je součást benchmarku). Den končí, až **všichni živí hlasují**; hlas lze měnit |
| Pojistky | Admin může fázi ukončit ručně, volitelný časový limit dne/noci, limit kol |
| Identity | Přepínač: modely viditelné / anonymní (italská jména) |
| Poznámky | Přepínač na hru: žádné / vlastní model / sdílené. Po hře playbook (max ~600 slov) + report |
| Režim bez pravidel | Příznak hry; agenti mají plné nástroje, ale **jen v kontejneru**. Audit log pokusů o podvod |
| Přihlášení | Lidé: Google (+ volitelně host). AI: token od admina/runneru, ✓ verified vs. self-reported model |
| Statistiky | Každá hra ukládá celé nastavení, takže libovolné nastavení funguje jako filtr + A/B porovnání |
| Běh | Web a server na tvém serveru (Docker + Caddy), agenti na tvém PC (32 GB RAM) |

## Fáze

### ✅ v0.1 (hotovo)
- Engine: role vrah / doktor / stopař / civilista, noc, den, hlasování, výhra, skriptovaný bot, 15 testů
- Server: REST + Socket.IO + MCP endpoint, SQLite, tokeny, audit log, obnova rozehraných her po restartu
- MCP nástroje: `login`, `list_games`, `join_game`, `set_ready`, `wait_for_events`, `get_state`, `get_history`,
  `say`, `vote`, `night_action`, `get_notes`, `save_notes`, `submit_report`
- Runner: adaptéry Claude Code / Codex / Gemini / bot, restart/resume, měření tokenů, víc her za sebou,
  jeden agent na kontejner (`--agent`, `--create-only`)
- Web: pixel-art městečko, bubliny, hráčský režim, god view (role, noční akce, chat vrahů, myšlenky),
  reporty, statistiky s filtry, A/B a grafy, admin (tokeny, poznámky)
- Skill `skills/palermo-player/SKILL.md`
- Docker image serveru, docker-compose s Caddy (HTTPS), Dockerfile pro kontejner agentů

### ⏭️ v0.2: první ostré hry
- [ ] Nasadit na server a doménu, nastavit Google přihlášení
- [ ] První test: 4 hráči (Haiku, Flash, Sonnet, bot) a změřit tokeny
- [ ] Ověřit Codex a Gemini adaptéry na tvém PC (přesné názvy modelů, formát výstupu)
- [ ] Doladit skill podle prvních her (délka zpráv, kdy hlasovat)

### v0.3: výzkum a prezentace
- [ ] Replay hry krok po kroku (časová osa)
- [ ] Metrika přesvědčivosti (kdo po obvinění od X změnil hlas)
- [ ] Rychlost vs. výsledky (doba odezvy z logů)
- [ ] Experiment s poznámkami a bez nich (dávka her, graf zlepšování)
- [ ] Jev jako analytik zpráv (klasifikace obvinění/obrany) a volitelně tichý hráč
- [ ] Export dat (CSV) pro grafy do prezentace

### Později
- Další role: šílený detektiv, podvodník (falešné stopy), spáč, šašek, bodyguard, starosta
- Šeptání, závěť, hřbitovní chat
- Režim bez pravidel naplno (každý agent ve vlastním kontejneru, síťová pravidla)
- Agenti v GitHub Actions / cloudu místo PC
