# Návod: jak Palermo rozjet

## 0. Stažení a aktualizace přes git (místo ZIPu)

Jednou nainstaluj Git (https://git-scm.com/download/win) a stáhni projekt:

```powershell
git clone -b claude/palermo-ai-game-yg3l72 https://github.com/102010jk/Palermo.git
cd Palermo
npm install
npm run build
```

Pokaždé, když řeknu, že je nová verze, stačí ve složce `Palermo` (se zastaveným serverem):

```powershell
npm run update
```

To stáhne změny, doinstaluje balíčky a znovu sestaví web. Data (hry, statistiky) ve složce `data/`
zůstanou, git je nepřepisuje.

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

## 3. Hra s Claude, Codexem a Gemini (agy)

1. Přihlas CLI na PC ke svým předplatným: `claude` (/login), `codex login`, `agy` (Antigravity, přihlášení Googlem).
2. Do `agents` dej skutečné hráče, např.:
   ```json
   { "name": "Haiku", "provider": "claude", "model": "haiku" },
   { "name": "Sonnet", "provider": "claude", "model": "sonnet" },
   { "name": "Flash", "provider": "agy", "model": "gemini-3.8-flash" },
   { "name": "Sol", "provider": "codex", "model": "gpt-5.6-sol" }
   ```
   Model je to, co bys napsal do `--model` daného CLI. Přesné názvy vypíše `agy models` (Antigravity), u Codexu `/model` v `codex`.
   (`"provider": "gemini"` pořád funguje pro staré Gemini CLI, ale Google ho pro osobní účty nahradil Antigravity CLI.)
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

Nejdřív spusť **`doctor.bat`** (server musí běžet). Bez použití AI otestuje každý krok spojení
(server, MCP, most přes lokální rouru i přes TCP, dlouhé čekání) a pak odehraje zkušební hru 5 botů
přesně stejnou cestou, jakou používá Claude. Nic to nestojí. Když všechno projde, `play.bat` poběží.

Hráči se k serveru připojují přes lokální most a pojmenovanou rouru Windows (`\\.\pipe\palermo-3000`),
ne přes síť. Na to nemají vliv proxy ani antivir kontrolující webový provoz. Síť (TCP) je jen záloha.

- **`Failed to authenticate` / `OAuth session expired`**: Claude CLI na PC má propadlé přihlášení.
  Nejspolehlivější je dlouhodobý token (zvládne i 6 hráčů najednou):
  ```powershell
  claude setup-token                      # otevře prohlížeč, vypíše token
  $env:CLAUDE_CODE_OAUTH_TOKEN="<token>"  # ve stejném okně, kde pak spustíš runner
  ```
  Nebo jednoduše spusť `claude` a v něm `/login`. Ověříš to příkazem `claude -p "hi" --model haiku`.
- **`palermo MCP: failed`**: Claude Code se nedostal na server. Zkontroluj, že server běží,
  a v konfiguraci používej `http://127.0.0.1:3000` (ve Windows `localhost` někdy míří na IPv6).
  Runner pak vypíše řádky `MCP debug: …` z ladicího logu Claude Code s přesnou příčinou
  (celý log je v `%TEMP%\palermo-runs\<hra>\<hráč>\claude-debug-0.log`). V okně serveru uvidíš
  `[mcp] … connected`, pokud se hráč spojil; když tam nic není, požadavek k serveru vůbec nedošel
  (proxy, firewall, antivir).
- Při takové chybě runner hráče znovu nespouští, vypíše postup opravy a nedohranou hru stopne.
  Stopnuté hry se do statistik nepočítají. Starou zaseknutou hru v lobby stopneš v UI tlačítkem **Stop game**.

### Nová hra: styl, role, série

Na **Games → ＋ New game**:
1. **Styl hry:** *Visual* (pro lidi: domy v kruhu, jedna zpráva po druhé, v god view noční obchůzky po sobě)
   nebo *Simulation* (pro AI experimenty: co nejrychleji). Ve statistikách se to dá filtrovat.
2. **Hráči:** počet míst, **Počet her** (víc než 1 = série: po konci hry se sama otevře další se stejným
   nastavením, hráči z čekací listiny s „repeat“ si sednou; průběh a Stop na stránce AI players).
3. **Role:** předvolby (Classic, Traps & guns, Chaos) nebo vlastní počty přes +/−; civilisté se dopočítají.
4. **Pravidla**, 5. **Čas a chat**.

Ve statistikách jsou nové filtry: sestava rolí, styl hry, série, způsob zabíjení.

**Export:** u každé hry v panelu Game master **Download JSON** (celá hra: pravidla/nastavení, všechny události,
myšlenky, reporty, tokeny). Na stránce Stats **Download CSV** (jeden řádek za hráče každé dohrané hry:
model, role, tým, výhra, přežil, styl hry, série…) pro Excel / analýzu.

### Došel limit předplatného? Hra se uloží a dohraje

- Když některý hráč narazí na limit (Claude „usage limit reached / resets 3pm“, Codex „You've hit your usage
  limit… try again in 2 hours“, Google „quota“), runner **hru pozastaví** (časovače stojí, nikdo nepřijde o tah)
  a počká, až se limit obnoví (čas vyčte z hlášky, jinak zkouší po 15 min). Pak hráč naváže a hra běží dál.
- Okno můžeš i zavřít, hra zůstane uložená a pozastavená:
  - hry z **agents.bat** (stránka AI players): po dalším spuštění `agents.bat` si hráči sami sednou zpátky
    na svá místa. Když agents.bat zavřeš uprostřed hry, server hru sám pozastaví.
  - hry z **play.bat**: spusť **`resume.bat`** (vezme poslední nedohranou hru) nebo `resume.bat g_abc123`.
- Na webu u hry uvidíš „paused: …“. Game master ji může ručně pozastavit/pokračovat (API `pause`/`resume`).

### Nové role

| Role | Tým | Co dělá |
|---|---|---|
| Vrah | mafie | Každou noc zabije jednoho hráče, nebo zůstane doma (`pass`). Dva vrazi nikdy nejdou do stejného domu. |
| Doktor | město | Chrání jednoho hráče. |
| Stopař | město | Zjistí, ke komu šel sledovaný (nebo že zůstal doma). |
| Pastičkář | město | Dá past před dům (i svůj, ne stejný dům dvakrát po sobě). Každý návštěvník tam selže a dozví se to; pastičkář se dozví roli chyceného, ne jméno. |
| Pistolník | město | Jeden náboj za hru, střílí ve dne veřejně (prozradí se). |
| Šílený vrah/doktor/stopař/pastičkář | město | Myslí si, že má danou roli, ale nic nedělá (zůstává doma), výsledky má vždy chybné. Oznamuje se jako zdánlivá role. Pravdu uvidí jen god view a na konci hry. |

| Břichomluvec | mafie | Nezabíjí. Jednou za den napíše do chatu zprávu, která vypadá, jako by ji řekl jiný živý hráč (`throw_voice`). Zná vrahy a v noci s nimi mluví; město ho musí vyřadit taky. |

| Poštovní holub | město | Každou noc jedna volba (`mail_bird`): až 2 anonymní dopisy (doručí se ráno), **propojení** dvou hráčů (další den si každý z nich může poslat jednu soukromou zprávu, `bird_message`), jednou za hru **zapečetěný dopis** místo pošty (přečte se všem, když holub zemře), nebo nic. |

Se šíleným vrahem ve hře se vrazi (i břichomluvec) navzájem neznají (jinak by se šílený prozradil).

#### Břichomluvec: co testuje

Zapíná se v *New game → Roles* počtem 🗣 Ventriloquist (0 = vypnuto, 1 = zapnuto), nebo presetem **Deception 9**.
V konfiguraci runneru: `"roleCounts": { "murderer": 2, "ventriloquist": 1, "doctor": 1, "tracker": 1 }`.

- Testuje, jestli si AI **všimne, že „řekla“ něco, co neřekla**, a ozve se (zapře to), nebo to mlčky přejde.
- Jestli ostatní AI **uvěří zapírání**, nebo „přistiženého lháře“ vyhlasují. Když hráči znají role ve hře
  (*Players know → The roles in play*), město ví, že padělky existují, a musí přemýšlet, čí slova jsou pravá.
- Jestli mafie umí padělek **koordinovat**: partneři v noci vidí, co a za koho břichomluvec řekl.
- Ve **god view** je padělaná zpráva označená 🗣 „forged by …“ (v logu i v bublině), hráči to nevidí.
  Ve statistikách se zpráva počítá skutečnému autorovi.

#### Poštovní holub: co testuje

Zapíná se počtem 🕊 Mail Bird v *New game → Roles* (0/1), nebo presetem **Letters 9**.
Testuje, **komu AI svěří tajemství**: jestli v soukromé zprávě prozradí roli někomu, kdo může být vrah,
jestli uvěří anonymnímu dopisu, a jestli holub umí včas zapsat, co ví, do zapečetěného dopisu.
Ve god view vidíš všechny dopisy i to, kdo je poslal (hráči je dostávají anonymně).

### Poslední slova

*New game → Rules → Last words* (výchozí zapnuto, `"lastWords": true`). Kdo zemře (v noci, hlasováním nebo
výstřelem), může nechat jednu veřejnou zprávu, a to do konce následující fáze. AI se kvůli tomu po smrti
jednou probudí. Na webu se zobrazí na „jevišti“ pod městem s popiskem 🪦.

### Co hráči vědí o rolích (*Players know*)

V *New game → Rules* je volba **Players know** (v konfiguraci `"roleInfo"`):

| Volba | `roleInfo` | Co hráči vědí |
|---|---|---|
| The roles in play | `exact` | Na začátku se oznámí přesné složení (např. 2× vrah, doktor, 5× civilista). |
| Only which roles can appear | `possible` | Složení je tajné. Vědí jen, jaké role ve hře **můžou** být (všechny role Palerma, i šílené), ne které a kolik. |
| Only their own role | `hidden` | Vědí jen svou roli. Neřekne se jim ani to, jaké role vůbec existují. AI hráčům runner v tomhle režimu **vymaže seznam rolí ze skillu**, takže je opravdu neznají a musí je odvodit z průběhu (úmrtí, odhalené role, tvrzení ostatních). |

Starší hry a konfigurace s `announceRoles` fungují dál (true = `exact`, false = `possible`).
Ve statistikách je filtr **Role knowledge**, takže jde porovnat, jak modely hrají, když vědí víc nebo míň.

### Pojistka proti zaseknutému hlasování a mazání her

- **Last votes: silence (s)** (výchozí 90 s): jakmile odhlasují 2/3 živých hráčů, den skončí po 90 s bez
  zprávy v chatu (dokud se diskutuje, běží dál, nejvýš 5 minut). Pak se počítají hlasy, které padly. Hráč, který nehlasoval, to vidí ve stavu hry.
  Prázdné pole = den čeká na všechny (dřív se tak dala hra zablokovat tím, že jeden hráč nehlasoval).
- **Smazání hry:** v ukončené hře (i zastavené přes *Stop game*) je v panelu Game master tlačítko
  **Delete game**. Smaže hru, reporty, spotřebu tokenů i verze playbooků uložené během té hry.
  Běžící hru nejdřív zastav.

### Limity chatu

V nastavení hry (formulář *New game* na webu, nebo `settings` v konfiguraci runneru) jdou zapnout a vypnout:

| Nastavení | Co dělá | Příklad |
|---|---|---|
| `maxMessageLength` | max. počet znaků ve zprávě (delší zprávu server odmítne) | 250 |
| `maxMessagesPerPhase` | max. počet zpráv na hráče za den (u vrahů i za noc) | 6 |
| `chatCooldownSec` | min. pauza mezi zprávami jednoho hráče (proti spamu) | 10 |

`null` (nebo vypnuté zaškrtávátko) = bez limitu. AI vidí limity ve svém stavu, takže se jim přizpůsobí.
`examples/sonnet4-haiku2.json` má všechny tři zapnuté. Ve statistikách jdou hry podle limitů filtrovat.

### Kde najdu poznámky (playbooky)

Web → *Game master login* → nahoře **Admin** → sekce **Notes / playbooks**. Každý model má svůj
(např. `anthropic:claude-sonnet-5`, `anthropic:claude-haiku-4-5-…`). Reporty z jednotlivých her jsou pod
danou hrou na její stránce.

### Vlastní hra s AI (i s tebou jako hráčem)

1. Na webu vytvoř hru (*New game*). **Seats** = počet AI + lidí. Zaškrtni *Auto-start*, nebo pak klikni **Start**.
2. Chceš hrát taky? Přihlas se jako host a klikni **Join** a **I'm ready**.
3. Spusť `join.bat` a zadej id hry (je v adrese, např. `g_ab12cd34`).
   AI hráči se posadí podle `examples\sonnet4-haiku2.json`.
   Jinou sestavu uděláš kopií toho souboru se změněným seznamem `agents`:
   `join.bat g_ab12cd34 examples\moje-sestava.json`

### AI hráči z menu – `agents.bat` + stránka **AI players** (nejpohodlnější)

1. `start-server.bat` (server) a vedle něj **`agents.bat`**. To je „spouštěč AI“. Zjistí, které CLI máš
   nainstalované (claude, codex, agy), a pošle webu seznam modelů. Okno nech otevřené.
2. Na webu (jako admin) otevři **AI players**. Vlevo je seznam modelů, klikem na **+** přidáš hráče do
   čekací listiny vpravo. Stejný model můžeš přidat víckrát, jméno hráče jde přepsat.
3. Na stránce **Games** založ lobby s počtem míst (volba *AI players from the waiting list may join* je
   zapnutá). Čekající hráči se do něj sami posadí, dokud jsou volná místa, a hra se spustí sama,
   jakmile je plno (*Auto-start*).
4. **repeat** = po konci hry hráč čeká na další lobby. Bez něj po hře z listiny zmizí.
   Když hráč nemůže hrát (není přihlášený, špatný model), uvidíš u něj chybu a tlačítko **Retry**.

Poznámky:
- Místa pro lidi: založ lobby s víc místy, než kolik AI čeká, a lidi se připojí přes web.
  Hry spuštěné přes `play.bat`/`join.bat` si hráče berou z vlastního configu a čekací listina do nich nesahá.
- Seznam modelů: Claude a Codex jsou v `models.json`, modely agy se berou automaticky z `agy models`.
  Vlastní přidáš do `models.local.json` (stejný formát, `update.bat` ho nepřepíše).
- Čekací listina se ukládá na serveru (`data/ai-pool.json`), přežije i restart.

### Hra s Gemini (Antigravity / agy) a GPT (Codex) – `play-mix6.bat`

Sestava v `examples\mix6.json`:

| Hráč | CLI | model |
|---|---|---|
| Sonnet | claude | `sonnet` (Sonnet 5) |
| Haiku | claude | `haiku` (Haiku 4.5) |
| Opus | claude | `claude-opus-5-5` (Opus 5.5) |
| Flash | agy | `gemini-3.8-flash-high` (Gemini 3.8 Flash, High) |
| Sol | codex | `gpt-5.6-sol` |
| Luna | codex | `gpt-5.6-luna` |

Jednou předem (PowerShell):
```powershell
irm https://antigravity.google/cli/install.ps1 | iex   # nainstaluje agy (Antigravity CLI)
agy                  # přihlas se Googlem, pak ukonči (Ctrl+C nebo /quit)
agy update           # aspoň verze 1.2.6 (starší ukončovaly headless běh po 5 minutách)
agy models           # vypíše přesné názvy modelů
npm install -g @openai/codex
codex login          # přihlášení ChatGPT účtem
```
`doctor.bat` pak ukáže `OK agy CLI` (i se seznamem modelů) a `OK codex CLI`.

Když runner napíše „rejected the model“, oprav název v `mix6.json`. U agy runner rovnou vypíše,
jaké modely máš k dispozici. Flash má tři úrovně přemýšlení: `gemini-3.8-flash-low`, `-medium`, `-high`
(runner si sám zjistí, jestli agy chce `--model gemini-3.8-flash --effort high`, nebo celý název).
Novější GPT-6 Sol/Luna (`gpt-6-sol`, `gpt-6-luna`) jde použít stejně, stačí změnit `model`.

**Co runner u agy dělá sám:**
- MCP server `palermo` zapíše do `.agents/mcp_config.json` v pracovní složce hráče (tvoje globální
  nastavení agy nemění).
- Do `%USERPROFILE%\.gemini\antigravity-cli\settings.json` jednou přidá pravidlo
  `"mcp(palermo/*)"` do `permissions.allow`. Headless agy jinak herní nástroje bez ptaní zamítne.
  Pravidlo povoluje jen nástroje hry, nic jiného.
- Jedno čekání (`wait_for_events`) omezí na 55 s, aby agy nevypršel časový limit nástroje.
- Když agy po poslední odpovědi „visí“ (známá chyba), po 20 s ho ukončí a pokračuje dál.

**Režim s pravidly u agy:** příkazy v terminálu agy v headless režimu sám nespustí (potřebují schválení)
a soubory smí číst jen v prázdné pracovní složce hráče. Přísnější vypnutí vestavěných nástrojů agy
zatím umí jen globálně, takže to runner nedělá.

**Codex:** hráči běží s vlastní čistou složkou Codexu (`%USERPROFILE%\.palermo\codex-home`), kam runner
zkopíruje jen tvoje přihlášení. Tvoje pluginy (Browser Use, prohlížeč, `js`), jiné MCP servery a paměť
tak do hry nezasahují. Když se přihlášení obnoví, runner ho zkopíruje zpátky do `~/.codex`.
Nástroje hry má Codex povolené bez ptaní (`default_tools_approval_mode = "approve"` jen pro server palermo).

**Bez Opusu:** `play-mix5.bat` (sestava `examples\mix5.json`) = stejná hra bez Opusu, 5 hráčů.
Statistiky ji vedou zvlášť (jiná sestava, režim `mix5`).

**Opus 5.5 a bezpečnostní filtr:** Opus 5.5 občas odmítne hru jako „safeguards flagged this message“
(planý poplach kvůli slovům jako vrah/zabít). Skill hru popisuje jako společenskou hru (Mafia/Werewolf);
když filtr přesto zasáhne, runner začne novou konverzaci místo té zablokované. Po 3 odmítnutích to vzdá
a napíše to.

Codex a Claude v režimu s pravidly mají vypnuté vlastní nástroje (terminál, soubory, web), takže můžou jen hrát.

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
- **Gemini (agy):** připoj kopii `~/.gemini` → `-v ~/.gemini-palermo:/home/player/.gemini`

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
