import { useState } from 'react';
import { api } from '../api.ts';

const ROLE_IDS = ['murderer', 'doctor', 'tracker', 'civilian'];

export function CreateGameForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [s, setS] = useState({
    mode: 'classic',
    seats: 6,
    autoStart: true,
    aiPool: true,
    identityVisibility: 'visible',
    notesMode: 'own',
    freedomMode: false,
    publicVotes: true,
    revealRoleOnDeath: true,
    allowSkipVote: true,
    announceRoles: true,
    startPhase: 'night',
    nightTimeoutSec: '180',
    dayTimeoutSec: '',
    voteDeadlineSec: '120',
    maxRounds: '15',
    limitLength: true,
    maxMessageLength: '250',
    limitCount: true,
    maxMessagesPerPhase: '6',
    limitCooldown: true,
    chatCooldownSec: '10',
    customRoles: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setS((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    try {
      setError(null);
      const roles = s.customRoles.trim()
        ? s.customRoles.split(/[\s,]+/).filter(Boolean)
        : 'auto';
      if (Array.isArray(roles) && roles.some((r) => !ROLE_IDS.includes(r))) throw new Error(`Roles must be from: ${ROLE_IDS.join(', ')}`);
      const settings = {
        mode: s.mode,
        seats: Number(s.seats) || 0,
        autoStart: s.autoStart,
        aiPool: s.aiPool,
        identityVisibility: s.identityVisibility,
        notesMode: s.notesMode,
        freedomMode: s.freedomMode,
        publicVotes: s.publicVotes,
        revealRoleOnDeath: s.revealRoleOnDeath,
        allowSkipVote: s.allowSkipVote,
        announceRoles: s.announceRoles,
        startPhase: s.startPhase,
        nightTimeoutSec: s.nightTimeoutSec ? Number(s.nightTimeoutSec) : null,
        dayTimeoutSec: s.dayTimeoutSec ? Number(s.dayTimeoutSec) : null,
        voteDeadlineSec: s.voteDeadlineSec ? Number(s.voteDeadlineSec) : null,
        maxRounds: s.maxRounds ? Number(s.maxRounds) : null,
        maxMessageLength: s.limitLength && s.maxMessageLength ? Number(s.maxMessageLength) : null,
        maxMessagesPerPhase: s.limitCount && s.maxMessagesPerPhase ? Number(s.maxMessagesPerPhase) : null,
        chatCooldownSec: s.limitCooldown && s.chatCooldownSec ? Number(s.chatCooldownSec) : null,
        roles,
      };
      const g = await api('POST', '/api/games', { settings }, { admin: true });
      onCreated(g.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>
        Mode label
        <input value={s.mode} onChange={(e) => set('mode', e.target.value)} />
      </label>
      <label>
        Seats
        <input type="number" min={3} max={30} value={s.seats} onChange={(e) => set('seats', e.target.value)} />
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
      <label>
        Game starts with
        <select value={s.startPhase} onChange={(e) => set('startPhase', e.target.value)}>
          <option value="night">Night</option>
          <option value="day">Day</option>
        </select>
      </label>
      <label>
        Night time limit (s)
        <input type="number" placeholder="none" value={s.nightTimeoutSec} onChange={(e) => set('nightTimeoutSec', e.target.value)} />
      </label>
      <label>
        Day time limit (s)
        <input type="number" placeholder="until everyone votes" value={s.dayTimeoutSec} onChange={(e) => set('dayTimeoutSec', e.target.value)} />
      </label>
      <label title="Once two thirds have voted, the rest get this long; then the day ends with the votes cast. Empty = wait for everyone.">
        Last votes within (s)
        <input type="number" placeholder="off (wait for everyone)" value={s.voteDeadlineSec} onChange={(e) => set('voteDeadlineSec', e.target.value)} />
      </label>
      <label>
        Max rounds
        <input type="number" placeholder="unlimited" value={s.maxRounds} onChange={(e) => set('maxRounds', e.target.value)} />
      </label>
      <fieldset className="wide chat-limits">
        <legend>Chat limits (turn each on or off)</legend>
        {(
          [
            ['limitLength', 'maxMessageLength', 'Max characters per message'],
            ['limitCount', 'maxMessagesPerPhase', 'Max messages per player per day'],
            ['limitCooldown', 'chatCooldownSec', 'Seconds between a player\'s messages'],
          ] as const
        ).map(([flag, key, label]) => (
          <label key={key} className="limit">
            <input type="checkbox" checked={s[flag] as boolean} onChange={(e) => set(flag, e.target.checked)} />
            <span>{label}</span>
            <input type="number" min={1} value={s[key] as string} disabled={!s[flag]} onChange={(e) => set(key, e.target.value)} />
          </label>
        ))}
      </fieldset>
      <label className="wide">
        Custom roles (optional)
        <input
          placeholder="auto, or e.g. murderer, doctor, tracker, civilian, civilian, civilian"
          value={s.customRoles}
          onChange={(e) => set('customRoles', e.target.value)}
        />
      </label>
      <div className="checks wide">
        {(
          [
            ['autoStart', 'Auto-start when all seats are ready'],
            ['aiPool', 'AI players from the waiting list may join'],
            ['publicVotes', 'Public votes'],
            ['revealRoleOnDeath', 'Reveal role on death'],
            ['allowSkipVote', 'Allow "skip" vote'],
            ['announceRoles', 'Announce role counts at start'],
            ['freedomMode', 'No-rules mode (agents get full tools)'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={s[k] as boolean} onChange={(e) => set(k, e.target.checked)} />
            {label}
          </label>
        ))}
      </div>
      {error && <p className="error wide">{error}</p>}
      <button type="submit" className="wide primary">
        Create game
      </button>
    </form>
  );
}
