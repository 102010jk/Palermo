import type { CSSProperties, ReactElement } from 'react';

/** Tiny pixel-art sprites rendered as SVG rects. Each string row is one pixel row; '.' is transparent. */

export type Look = 'claude' | 'openai' | 'gemini' | 'human' | 'bot' | 'unknown';

interface Palette {
  O: string; // outline
  M: string; // head
  E: string; // eyes / glow
  B: string; // body
  X: string; // emblem
  A: string; // antenna / hat
  S?: string; // skin
  H?: string; // hair
}

export const LOOKS: Record<Look, { palette: Palette; label: string; color: string }> = {
  claude: {
    label: 'Claude',
    color: '#d97757',
    palette: { O: '#2a1a14', M: '#f0b89c', E: '#2a1a14', B: '#d97757', X: '#fff4ec', A: '#d97757' },
  },
  openai: {
    label: 'GPT',
    color: '#10a37f',
    palette: { O: '#0b1f19', M: '#bdeee0', E: '#0b1f19', B: '#10a37f', X: '#f4fffb', A: '#10a37f' },
  },
  gemini: {
    label: 'Gemini',
    color: '#5b8def',
    palette: { O: '#111a33', M: '#cfdcff', E: '#111a33', B: '#5b8def', X: '#c9a7ff', A: '#a77bf3' },
  },
  human: {
    label: 'Human',
    color: '#e8b04b',
    palette: { O: '#2b1d10', M: '#f2c79b', E: '#2b1d10', B: '#3f6fd8', X: '#dbe6ff', A: '#6b4226', S: '#f2c79b', H: '#6b4226' },
  },
  bot: {
    label: 'Bot',
    color: '#9aa3b2',
    palette: { O: '#1c2029', M: '#c9ced8', E: '#e2574c', B: '#7b8494', X: '#c9ced8', A: '#7b8494' },
  },
  unknown: {
    label: 'Unknown',
    color: '#8a8f98',
    palette: { O: '#1c1c22', M: '#b9bcc4', E: '#1c1c22', B: '#6b6f78', X: '#e9e9ee', A: '#6b6f78' },
  },
};

const ANTENNA: Record<Look, string[]> = {
  claude: ['....A..A....', '.....AA.....', '....A..A....'],
  openai: ['.....AA.....', '....A..A....', '.....AA.....'],
  gemini: ['.....A......', '....AAA.....', '.....A......'],
  bot: ['.....EE.....', '......A.....', '......A.....'],
  unknown: ['....XXX.....', '......X.....', '.....X......'],
  human: ['............', '............', '............'],
};

const ROBOT = [
  '..OOOOOOOO..',
  '..OMMMMMMO..',
  '..OMEMMEMO..',
  '..OMMMMMMO..',
  '..OMMEEMMO..',
  '..OOOOOOOO..',
  '...OBBBBO...',
  '..OBBXXBBO..',
  '.OBBXXXXBBO.',
  '.OMBBXXBBMO.',
  '..OBBBBBBO..',
  '..OBBOOBBO..',
  '..OBBOOBBO..',
  '..OOO..OOO..',
];

const HUMAN = [
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..OSSSSSSO..',
  '..OSESSESO..',
  '..OSSSSSSO..',
  '...OSSSSO...',
  '..OBBBBBBO..',
  '.OBBBXXBBBO.',
  '.OBBBXXBBBO.',
  '.OSBBBBBBSO.',
  '..OBBBBBBO..',
  '..OBBOOBBO..',
  '..OBBOOBBO..',
  '..OOO..OOO..',
];

const GRAVE = [
  '............',
  '............',
  '............',
  '....OOOO....',
  '...OGGGGO...',
  '..OGGGGGGO..',
  '..OGGOGGGO..',
  '..OGOOOGGO..',
  '..OGGOGGGO..',
  '..OGGGGGGO..',
  '..OGGGGGGO..',
  '..OGGGGGGO..',
  '.OOOOOOOOOO.',
  '.ODDDDDDDDO.',
  '............',
  '............',
  '............',
];

function Pixels({ rows, colors, scale, style, className }: { rows: string[]; colors: Record<string, string>; scale: number; style?: CSSProperties; className?: string }) {
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const rects: ReactElement[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      let run = 1;
      while (x + run < row.length && row[x + run] === c) run++;
      if (c !== '.' && colors[c]) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={run} height={1} fill={colors[c]} />);
      x += run;
    }
  });
  return (
    <svg
      className={className}
      style={style}
      width={w * scale}
      height={h * scale}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rects}
    </svg>
  );
}

export function lookFor(p: { kind?: string; provider?: string; model?: string }): Look {
  if (p.kind === 'human') return 'human';
  if (p.kind === 'bot' || p.provider === 'script') return 'bot';
  const s = `${p.provider ?? ''} ${p.model ?? ''}`.toLowerCase();
  if (/anthropic|claude|opus|sonnet|haiku|fable/.test(s)) return 'claude';
  if (/openai|gpt|codex|o\d/.test(s)) return 'openai';
  if (/google|gemini|gemma/.test(s)) return 'gemini';
  if (p.kind === 'ai') return 'unknown';
  return 'unknown';
}

export function Character({ look, scale = 4, className, style }: { look: Look; scale?: number; className?: string; style?: CSSProperties }) {
  const { palette } = LOOKS[look];
  const rows = look === 'human' ? [...ANTENNA.human.slice(0, 3), ...HUMAN] : [...ANTENNA[look], ...ROBOT];
  return <Pixels rows={rows} colors={palette as unknown as Record<string, string>} scale={scale} className={className} style={style} />;
}

export function Grave({ scale = 4 }: { scale?: number }) {
  return <Pixels rows={GRAVE} colors={{ O: '#1a1a22', G: '#8d93a1', D: '#5a4632' }} scale={scale} />;
}

const HOUSE = [
  '.......RR.......',
  '......RRRR......',
  '.....RRRRRR.....',
  '....RRRRRRRR....',
  '...RRRRRRRRRR...',
  '..RRRRRRRRRRRR..',
  '.RRRRRRRRRRRRRR.',
  '..WWWWWWWWWWWW..',
  '..WLLWWWWWWLLW..',
  '..WLLWWDDWWLLW..',
  '..WWWWWDDWWWWW..',
  '..WWWWWDDWWWWW..',
];

export function House({ night, scale = 4, roof = '#b4533c' }: { night: boolean; scale?: number; roof?: string }) {
  return (
    <Pixels
      rows={HOUSE}
      scale={scale}
      colors={{
        R: night ? shade(roof, 0.45) : roof,
        W: night ? '#3a3552' : '#efe3c8',
        L: night ? '#ffd76a' : '#7fb3d5',
        D: night ? '#241f36' : '#7a5230',
      }}
    />
  );
}

export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
