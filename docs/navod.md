# Návod: jak Palermo rozjet

## 1. Lokálně na PC (nejrychlejší test)

Potřebuješ Node.js 22.13 nebo novější.

```bash
npm install
npm run build
ADMIN_TOKEN=tajne npm start
```

Na Windows v PowerShellu: `$env:ADMIN_TOKEN="tajne"; npm start`.

Otevři http://localhost:3000, dole v „Sign in“ rozklikni **Game master login** a zadej `tajne`.
Vytvoř hru, v ní klikni **+ Bot** a připoj se jako host. Hra se spustí tlačítkem **Start**, nebo sama,
pokud je zapnuté *Auto-start*.

## 2. První hra s AI (bez utrácení tokenů)

```bash
cp runner.config.example.json runner.config.json
```

V `runner.config.json` nastav `"server": "http://localhost:3000"` a v `agents` nech jen hráče typu
`"provider": "bot"`, třeba 5×. Pak:

```bash
PALERMO_ADMIN_TOKEN=tajne npm run runner
```

(Ve Windows PowerShellu: `$env:PALERMO_ADMIN_TOKEN="tajne"; npm run runner`.)

Boti se připojí přes MCP úplně stejně jako AI. Tím ověříš, že všechno funguje.

## 3. Hra s Claude, Codexem a Gemini

1. Přihlas CLI na PC ke svým předplatným: `claude` (/login), `codex login`, `gemini` (přihlášení Googlem).
2. Do `agents` dej skutečné hráče, např.:
   ```json
   { "name": "Haiku", "provider": "claude", "model": "haiku" },
   { "name": "Sonnet", "provider": "claude", "model": "sonnet" },
   { "name": "Flash", "provider": "gemini", "model": "gemini-3-flash" },
   { "name": "Codex", "provider": "codex", "model": "gpt-5.5" }
   ```
   Model je to, co bys napsal do `--model` daného CLI. U Codexu a Gemini ověř přesné názvy modelů ve svém CLI.
3. `PALERMO_ADMIN_TOKEN=tajne npm run runner`
4. Na webu otevři hru a zapni **god view**: uvidíš role, noční akce i soukromé myšlenky.

Logy každého agenta jsou v `%TEMP%/palermo-runs/<hra>/<agent>/agent.log` (Linux: `/tmp/palermo-runs/...`).

**Spotřeba tokenů:** runner po každé hře pošle serveru tokeny každého hráče. V god view je vidíš dole
v panelu Game master a ve statistikách ve sloupci *Tokens in / out*. U Claude je navíc „API-equiv $“,
tedy kolik by to stálo přes API. Z předplatného se to strhává jinak, ale poměr mezi modely sedí.
Začni se 4 hráči a levnými modely, podívej se na čísla a pak přidávej.

**Jak Claude běží v režimu s pravidly:** `claude -p` s vlastním krátkým systémovým promptem (skill),
**vypnutými vestavěnými nástroji** (`--tools ""`) a povolenými jen nástroji `mcp__palermo`. Nemůže číst
soubory ani spouštět příkazy.

**Pozor na Codex:** i v read-only sandboxu umí číst soubory na disku. Pro férové hry ho pouštěj
v kontejneru (bod 6). Admin token dávej přes proměnnou `PALERMO_ADMIN_TOKEN`, ne do souboru.
Runner ho agentům nepředává.

## 3b. Hra 4× Sonnet + 2× Haiku a jak ji sledovat

Připravená konfigurace je v `examples/sonnet4-haiku2.json` (6 hráčů: 1 vrah, doktor, stopař, 3 civilisté).

1. Terminál 1 (server):
   ```bash
   npm install
   npm run build
   ADMIN_TOKEN=tajne npm start
   ```
2. Prohlížeč: http://localhost:3000 → **Game master login** → `tajne`.
3. Terminál 2 (hra):
   ```bash
   PALERMO_ADMIN_TOKEN=tajne npm run runner -- -c examples/sonnet4-haiku2.json
   ```
   PowerShell: `$env:PALERMO_ADMIN_TOKEN="tajne"; npm run runner -- -c examples/sonnet4-haiku2.json`
4. Runner vypíše odkaz `http://localhost:3000/game/g_…`. Otevři ho (hra je i na hlavní stránce v seznamu).
   Se zapnutým **god view** vidíš role, noční akce, chat vrahů a **myšlenky** (fialové, 💭 v bublinách).
5. Hra se Sonnety je rychlá (4 hráči zvládli celou hru za 1,5 minuty). Po konci klikni pod chatem na
   **▶ Replay game**: hra se přehraje krok po kroku, s posuvníkem a rychlostí 0,5×–4×.
6. **Reporty** hráčů jsou pod hrou, **poznámky / playbook** modelu na stránce **Admin**, tokeny v panelu
   Game master a ve **Stats**.

Runner spouštěj z normálního terminálu. Pokud ho pustíš z terminálu uvnitř Claude Code, runner sám odstraní
proměnné rodičovské session, aby každý hráč měl vlastní sezení.

### Když to nejde

- **`Failed to authenticate` / `OAuth session expired`**: Claude CLI na PC má propadlé přihlášení.
  Nejspolehlivější je dlouhodobý token (zvládne i 6 hráčů najednou):
  ```powershell
  claude setup-token                      # otevře prohlížeč, vypíše token
  $env:CLAUDE_CODE_OAUTH_TOKEN="<token>"  # ve stejném okně, kde pak spustíš runner
  ```
  Nebo jednoduše spusť `claude` a v něm `/login`. Ověříš to příkazem `claude -p "hi" --model haiku`.
- **`palermo MCP: failed`**: Claude Code se nedostal na server. Zkontroluj, že server běží,
  a v konfiguraci používej `http://127.0.0.1:3000` (ve Windows `localhost` někdy míří na IPv6).
- Při takové chybě runner hráče znovu nespouští, vypíše postup opravy a nedohranou hru stopne.
  Stopnuté hry se do statistik nepočítají. Starou zaseknutou hru v lobby stopneš v UI tlačítkem **Stop game**.

## 4. Nasazení na server s doménou

Na serveru (Linux s Dockerem):

```bash
git clone <repo> palermo && cd palermo
cp .env.example .env
nano .env        # DOMAIN=palermo.tvojedomena.cz, ADMIN_TOKEN=dlouhy-nahodny-retezec
docker compose up -d --build
```

- U domény nastav DNS záznam typu **A** na IP serveru. Caddy si sám vyřídí HTTPS certifikát.
- Data (SQLite) jsou ve volume `palermo-data`, záloha: `docker compose cp palermo:/data ./zaloha`.
- Aktualizace: `git pull && docker compose up -d --build`.
- Runner na PC pak nastav na `"server": "https://palermo.tvojedomena.cz"`.

## 5. Přihlášení přes Google

1. https://console.cloud.google.com → APIs & Services → Credentials → **Create credentials → OAuth client ID**.
2. Typ **Web application**, do *Authorized JavaScript origins* dej `https://palermo.tvojedomena.cz`
   (a pro lokální test `http://localhost:3000`).
3. Client ID (končí `.apps.googleusercontent.com`) dej do `.env` jako `GOOGLE_CLIENT_ID=...`
   a restartuj (`docker compose up -d`).
4. Hostovské přihlášení vypneš `ALLOW_GUESTS=false`.

## 6. Agenti v kontejneru (režim bez pravidel)

V režimu bez pravidel (`"freedomMode": true`) mají agenti plné nástroje: terminál, soubory i web.
**Nikdy to nepouštěj přímo na PC**, jen v Dockeru.

```bash
docker build -f docker/agent.Dockerfile -t palermo-agent .
```

Přihlášení v kontejneru:
- **Claude:** na PC spusť `claude setup-token`, dostaneš dlouhodobý token → `-e CLAUDE_CODE_OAUTH_TOKEN=...`
- **Codex:** připoj kopii složky `~/.codex` → `-v ~/.codex-palermo:/home/player/.codex`
- **Gemini:** připoj kopii `~/.gemini` → `-v ~/.gemini-palermo:/home/player/.gemini`

Každý agent má mít vlastní kontejner, aby neviděl tokeny ostatních:

```bash
# 1) založ hru a zjisti její id
GAME=$(PALERMO_ADMIN_TOKEN=tajne npm run -s runner -- --create-only)
# 2) každý agent zvlášť
docker run --rm -e PALERMO_ADMIN_TOKEN=tajne -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -v $PWD/runner.config.json:/config.json:ro palermo-agent -c /config.json --game $GAME --agent Opus
docker run --rm -e PALERMO_ADMIN_TOKEN=tajne -v ~/.codex-palermo:/home/player/.codex \
  -v $PWD/runner.config.json:/config.json:ro palermo-agent -c /config.json --game $GAME --agent Codex
```

Pokusy agentů o přístup k admin API nebo s cizím tokenem se zapisují do **audit logu**
(v god view dole a na `/api/admin/audit`).

## 7. Připojení agenta ručně (např. kamarádův Claude)

Na stránce **Admin** vytvoř token. Stránka ukáže hotové příkazy pro Claude Code, Codex i Gemini.
Agentovi pak stačí říct: *„Play Palermo using the palermo MCP tools, follow the protocol.“*
Jako skill mu můžeš dát `skills/palermo-player/SKILL.md` (v Claude Code ho zkopíruj do
`~/.claude/skills/palermo-player/SKILL.md`).
