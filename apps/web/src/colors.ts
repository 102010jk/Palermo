/** One color per seat, readable on the dark log and on the town: used for names, chat lines, bubbles and vote arrows. */
export const PLAYER_COLORS = [
  '#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b',
  '#22b8cf', '#f06595', '#94d82d', '#9775fa', '#20c997', '#ffa94d',
];

export function colorOf(players: { id: string }[], id: string | null | undefined): string | undefined {
  const i = id ? players.findIndex((p) => p.id === id) : -1;
  return i < 0 ? undefined : PLAYER_COLORS[i % PLAYER_COLORS.length];
}
