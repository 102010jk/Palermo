import { useState } from 'react';
import { ROLE_ORDER, ROLES, type RoleId } from '@palermo/engine';
import { api } from '../api.ts';

const ICON: Record<string, string> = {
  murderer: '🔪',
  doctor: '✚',
  tracker: '👁',
  trapper: '🪤',
  gunman: '🔫',
  ventriloquist: '🗣',
  civilian: '🏠',
};
const iconOf = (r: RoleId) => (ROLES[r].appearsAs ? `🌀${ICON[ROLES[r].appearsAs!]}` : ICON[r]);

type Counts = Partial<Record<RoleId, number>>;

const PRESETS: { id: string; label: string; hint: string; counts: Counts | null }[] = [
  { id: 'auto', label: 'Classic (auto)', hint: 'Murderers, doctor and tracker scaled to the player count', counts: null },
  { id: 'classic6', label: 'Classic 6', hint: '1 murderer, doctor, tracker', counts: { murderer: 1, doctor: 1, tracker: 1 } },
  { id: 'classic10', label: 'Classic 10', hint: '2 murderers, doctor, tracker, trapper', counts: { murderer: 2, doctor: 1, tracker: 1, trapper: 1 } },
  { id: 'guns8', label: 'Traps & guns 8', hint: '2 murderers, doctor, trapper, gunman', counts: { murderer: 2, doctor: 1, trapper: 1, gunman: 1 } },
  {
    id: 'deception9',
    label: 'Deception 9',
    hint: '2 murderers + ventriloquist, doctor, tracker: who really said that?',
    counts: { murderer: 2, ventriloquist: 1, doctor: 1, tracker: 1 },
  },
  {
    id: 'chaos10',
    label: 'Chaos 10',
    hint: '2 murderers, doctor, tracker, trapper, gunman, a crazy murderer',
    counts: { murderer: 2, doctor: 1, tracker: 1, trapper: 1, gunman: 1, crazy_murderer: 1 },
  },
];

const SPECIAL_ROLES = ROLE_ORDER.filter((r) => r !== 'civilian');

export function CreateGameForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [s, setS] = useState({
    mode: 'classic',
    games: '1',
    gameStyle: 'visual' as 'visual' | 'simulation',
    seats: 8,
    autoStart: true,
    aiPool: true,
    identityVisibility: 'visible',
    notesMode: 'own',
    freedomMode: false,
    publicVotes: true,
    revealRoleOnDeath: true,
    allowSkipVote: true,
    announceRoles: true,
    killMode: 'separate',
    startPhase: 'night',
    nightTimeoutSec: '180',
    dayTimeoutSec: '',
    voteDeadlineSec: '90',
    maxRounds: '15',
    limitLength: true,
    maxMessageLength: '250',
    limitCount: true,
    maxMessagesPerPhase: '6',
    limitCooldown: true,
    chatCooldownSec: '10',
  });
  const [preset, setPreset] = useState('classic10');
  const [counts, setCounts] = useState<Counts>(PRESETS.find((p) => p.id === 'classic10')!.counts!);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setS((x) => ({ ...x, [k]: v }));

  const auto = preset === 'auto';
  const seats = Number(s.seats) || 0;
  const specials = SPECIAL_ROLES.reduce((n, r) => n + (counts[r] ?? 0), 0);
  const murderers = counts.murderer ?? 0;
  const civilians = seats ? seats - specials : null;
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!auto) {
    if (!murderers) problems.push('Add at least one murderer.');
    if (seats && specials > seats) problems.push(`The roles need ${specials} players but the game has ${seats} seats.`);
    if (seats && murderers * 2 >= seats) problems.push('Murderers would win at once: they must be fewer than half of the players.');
    else if (seats && murderers * 3 > seats) warnings.push('Many murderers for this table: kills are separate, so the town may lose fast.');
    if ((counts.crazy_murderer ?? 0) > 0) warnings.push('With a crazy murderer the murderers do not know each other and have no night chat.');
  }

  const change = (r: RoleId, d: number) => {
    setPreset('custom');
    setCounts((c) => ({ ...c, [r]: Math.max(0, Math.min(10, (c[r] ?? 0) + d)) }));
  };
  const choosePreset = (id: string) => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id);
    if (p?.counts) setCounts({ ...p.counts });
  };

  const submit = async () => {
    try {
      setError(null);
      if (problems.length) throw new Error(problems[0]);
      const roleCounts = auto ? null : Object.fromEntries(Object.entries(counts).filter(([, n]) => (n ?? 0) > 0));
      const settings = {
        mode: s.mode,
        gameStyle: s.gameStyle,
        seats,
        autoStart: s.autoStart,
        aiPool: s.aiPool,
        identityVisibility: s.identityVisibility,
        notesMode: s.notesMode,
        freedomMode: s.freedomMode,
        publicVotes: s.publicVotes,
        revealRoleOnDeath: s.revealRoleOnDeath,
        allowSkipVote: s.allowSkipVote,
        announceRoles: s.announceRoles,
        killMode: s.killMode,
        startPhase: s.startPhase,
        nightTimeoutSec: s.nightTimeoutSec ? Number(s.nightTimeoutSec) : null,
        dayTimeoutSec: s.dayTimeoutSec ? Number(s.dayTimeoutSec) : null,
        voteDeadlineSec: s.voteDeadlineSec ? Number(s.voteDeadlineSec) : null,
        maxRounds: s.maxRounds ? Number(s.maxRounds) : null,
        maxMessageLength: s.limitLength && s.maxMessageLength ? Number(s.maxMessageLength) : null,
        maxMessagesPerPhase: s.limitCount && s.maxMessagesPerPhase ? Number(s.maxMessagesPerPhase) : null,
        chatCooldownSec: s.limitCooldown && s.chatCooldownSec ? Number(s.chatCooldownSec) : null,
        roles: 'auto',
        roleCounts,
      };
      const count = Math.floor(Number(s.games) || 1);
      if (count > 1) {
        const x = await api('POST', '/api/admin/series', { settings, count }, { admin: true });
        onCreated(x.firstGame);
        return;
      }
      const g = await api('POST', '/api/games', { settings }, { admin: true });
      onCreated(g.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <form
      className="create-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <section className="cf-section">
        <h3>1 · Game style</h3>
        <div className="style-cards">
          {(
            [
              ['visual', '🏘️ Visual', 'For people watching or playing: houses in a ring, one message at a time, nights played out in the god view.'],
              ['simulation', '⚡ Simulation', 'For AI experiments: as fast as the players are, simple view. Recorded in the stats as its own mode.'],
            ] as const
          ).map(([id, title, text]) => (
            <button type="button" key={id} className={`style-card ${s.gameStyle === id ? 'on' : ''}`} onClick={() => set('gameStyle', id)}>
              <b>{title}</b>
              <span>{text}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="cf-section">
        <h3>2 · Players</h3>
        <div className="cf-row">
          <label>
            Seats
            <input type="number" min={3} max={30} value={s.seats} onChange={(e) => set('seats', e.target.value)} />
          </label>
          <label title="More than 1: a series. The next game opens as soon as one ends, with the same settings; players on the AI waiting list with 'repeat' take the seats.">
            Number of games
            <input type="number" min={1} max={1000} value={s.games} onChange={(e) => set('games', e.target.value)} />
          </label>
          <label>
            Label (for stats)
            <input value={s.mode} onChange={(e) => set('mode', e.target.value)} />
          </label>
          <label>
            Identities
            <select value={s.identityVisibility} onChange={(e) => set('identityVisibility', e.target.value)}>
              <option value="visible">Visible (models shown)</option>
              <option value="anonymous">Anonymous (town names)</option>
            </select>
          </label>
          <label>
            Notes from past games
            <select value={s.notesMode} onChange={(e) => set('notesMode', e.target.value)}>
              <option value="own">Own model's notes</option>
              <option value="shared">All notes (shared)</option>
              <option value="none">No notes</option>
            </select>
          </label>
        </div>
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={s.autoStart} onChange={(e) => set('autoStart', e.target.checked)} /> Start automatically when all seats are ready
          </label>
          <label className="check">
            <input type="checkbox" checked={s.aiPool} onChange={(e) => set('aiPool', e.target.checked)} /> AI players from the waiting list may join
          </label>
        </div>
      </section>

      <section className="cf-section">
        <h3>3 · Roles</h3>
        <div className="preset-row">
          {PRESETS.map((p) => (
            <button type="button" key={p.id} className={`preset ${preset === p.id ? 'on' : ''}`} onClick={() => choosePreset(p.id)} title={p.hint}>
              {p.label}
            </button>
          ))}
          <span className={`preset ghost ${preset === 'custom' ? 'on' : ''}`}>Custom</span>
        </div>
        {auto ? (
          <p className="muted">The classic table: 1 murderer up to 6 players, 2 up to 10, 3 up to 14; a doctor from 3 and a tracker from 5 players.</p>
        ) : (
          <>
            <div className="role-grid">
              {SPECIAL_ROLES.map((r) => {
                const n = counts[r] ?? 0;
                const def = ROLES[r];
                return (
                  <div key={r} className={`role-card ${def.team} ${def.appearsAs ? 'crazy' : ''} ${n ? 'on' : ''}`}>
                    <div className="role-head">
                      <span className="role-icon">{iconOf(r)}</span>
                      <b>{def.name}</b>
                      <span className={`team-badge ${def.team}`}>{def.team === 'mafia' ? 'mafia' : 'town'}</span>
                    </div>
                    <p>{def.summary}</p>
                    <div className="stepper">
                      <button type="button" onClick={() => change(r, -1)} disabled={!n}>
                        −
                      </button>
                      <span>{n}</span>
                      <button type="button" onClick={() => change(r, 1)}>
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="role-card town civilians">
                <div className="role-head">
                  <span className="role-icon">{ICON.civilian}</span>
                  <b>Civilian</b>
                  <span className="team-badge town">town</span>
                </div>
                <p>{ROLES.civilian.summary}</p>
                <div className="stepper">
                  <span>{civilians === null ? 'the rest' : Math.max(0, civilians)}</span>
                </div>
              </div>
            </div>
            {problems.map((p) => (
              <p key={p} className="error">
                {p}
              </p>
            ))}
            {warnings.map((w) => (
              <p key={w} className="warn-note">
                {w}
              </p>
            ))}
          </>
        )}
      </section>

      <section className="cf-section">
        <h3>4 · Rules</h3>
        <div className="cf-row">
          <label>
            Game starts with
            <select value={s.startPhase} onChange={(e) => set('startPhase', e.target.value)}>
              <option value="night">Night</option>
              <option value="day">Day</option>
            </select>
          </label>
          <label>
            Murderers kill
            <select value={s.killMode} onChange={(e) => set('killMode', e.target.value)}>
              <option value="separate">Separately (different houses or pass)</option>
              <option value="shared">Together (one victim per night)</option>
            </select>
          </label>
        </div>
        <div className="checks">
          {(
            [
              ['announceRoles', 'Announce the role setup at the start'],
              ['revealRoleOnDeath', 'Reveal the role on death'],
              ['publicVotes', 'Public votes'],
              ['allowSkipVote', 'Allow a "skip" vote'],
              ['freedomMode', 'No-rules mode (agents get full tools)'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={s[k] as boolean} onChange={(e) => set(k, e.target.checked)} />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section className="cf-section">
        <h3>5 · Time and chat</h3>
        <div className="cf-row">
          <label>
            Night time limit (s)
            <input type="number" placeholder="none" value={s.nightTimeoutSec} onChange={(e) => set('nightTimeoutSec', e.target.value)} />
          </label>
          <label>
            Day time limit (s)
            <input type="number" placeholder="until everyone votes" value={s.dayTimeoutSec} onChange={(e) => set('dayTimeoutSec', e.target.value)} />
          </label>
          <label title="Once two thirds have voted, the day ends after this many seconds without a chat message (at most 5 min). Empty = wait for everyone.">
            Last votes: silence (s)
            <input type="number" placeholder="off (wait for everyone)" value={s.voteDeadlineSec} onChange={(e) => set('voteDeadlineSec', e.target.value)} />
          </label>
          <label>
            Max rounds
            <input type="number" placeholder="unlimited" value={s.maxRounds} onChange={(e) => set('maxRounds', e.target.value)} />
          </label>
        </div>
        <fieldset className="chat-limits">
          <legend>Chat limits (turn each on or off)</legend>
          {(
            [
              ['limitLength', 'maxMessageLength', 'Max characters per message'],
              ['limitCount', 'maxMessagesPerPhase', 'Max messages per player per day'],
              ['limitCooldown', 'chatCooldownSec', "Seconds between a player's messages"],
            ] as const
          ).map(([flag, key, label]) => (
            <label key={key} className="limit">
              <input type="checkbox" checked={s[flag] as boolean} onChange={(e) => set(flag, e.target.checked)} />
              <span>{label}</span>
              <input type="number" min={1} value={s[key] as string} disabled={!s[flag]} onChange={(e) => set(key, e.target.value)} />
            </label>
          ))}
        </fieldset>
      </section>

      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary create-btn" disabled={problems.length > 0}>
        {Number(s.games) > 1 ? `Start a series of ${Math.floor(Number(s.games))} games` : 'Create game'}
      </button>
    </form>
  );
}
