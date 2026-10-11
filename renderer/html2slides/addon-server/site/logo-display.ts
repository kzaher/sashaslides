// The Sasha Slides logo as a small display. Seeds sit at the golden angle (137.5°); each seed owns
// the region of the disc closest to it (its Voronoi cell), and those 34 cells are the pixels. Every
// pattern lights them along a structure the seeds already have: Fibonacci spirals, rings, angle.
// Built to public/logo-display.js by `npm run build:site`.

export const SEED_COUNT = 34;
/** Light, mid, dark: the logo's silver, a step down, and the graphite of the cell gaps. */
export const TONES = ["#F5F5F7", "#AEAEB2", "#636366"] as const;
export type Tone = 0 | 1 | 2;

type Point = readonly [number, number];
export type SeedCell = Readonly<{
  /** 0-based seed order; seed k sits at angle k·137.5°, radius ∝ √k. */
  index: number;
  seed: Point;
  /** Seed distance from the centre, 0 at the centre and 1 at the rim. */
  radial: number;
  /** Seed angle in radians, −π to π. */
  angle: number;
  polygon: readonly Point[];
}>;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Keeps the part of a convex polygon nearer `p` than `q`. */
function clipToward(polygon: readonly Point[], p: Point, q: Point): Point[] {
  const mx = (p[0] + q[0]) / 2;
  const my = (p[1] + q[1]) / 2;
  const nx = q[0] - p[0];
  const ny = q[1] - p[1];
  const side = ([x, y]: Point): number => (x - mx) * nx + (y - my) * ny;
  const kept: Point[] = [];
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) kept.push(a);
    if (sa < 0 !== sb < 0 && sa !== sb) {
      const t = sa / (sa - sb);
      kept.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  });
  return kept;
}

export function seedCells({ count, radius }: Readonly<{ count: number; radius: number }>): SeedCell[] {
  const spacing = radius / Math.sqrt(count + 0.5);
  const seeds: Point[] = [];
  for (let k = 1; k <= count; k++) {
    const r = spacing * Math.sqrt(k - 0.5);
    seeds.push([r * Math.cos(k * GOLDEN_ANGLE), r * Math.sin(k * GOLDEN_ANGLE)]);
  }
  const disc: Point[] = [];
  for (let k = 0; k < 96; k++) disc.push([radius * Math.cos((k / 96) * 2 * Math.PI), radius * Math.sin((k / 96) * 2 * Math.PI)]);
  return seeds.map((seed, index) => {
    let polygon: readonly Point[] = disc;
    seeds.forEach((other, j) => {
      if (j !== index) polygon = clipToward(polygon, seed, other);
    });
    return { index, seed, radial: Math.hypot(seed[0], seed[1]) / radius, angle: Math.atan2(seed[1], seed[0]), polygon };
  });
}

export type Pattern = Readonly<{ name: string; tone: (cell: SeedCell) => Tone }>;

const alternate = (family: number) => (cell: SeedCell): Tone => ((cell.index % family) % 2 === 1 ? 0 : 2);
const threeTone = (family: number) => (cell: SeedCell): Tone => ((cell.index % family) % 3) as Tone;

export const PATTERNS: readonly Pattern[] = [
  { name: "spirals of 8", tone: alternate(8) },
  { name: "spirals of 13", tone: alternate(13) },
  { name: "spirals of 5, three tones", tone: threeTone(5) },
  { name: "rings", tone: (cell) => (cell.radial < 0.45 ? 0 : cell.radial < 0.78 ? 1 : 2) },
  { name: "spirals of 3", tone: threeTone(3) },
  { name: "thirds", tone: (cell) => (Math.floor(((cell.angle + Math.PI) / (2 * Math.PI)) * 3) % 3) as Tone },
  { name: "spirals of 21", tone: alternate(21) },
];

/** Shrinks a convex polygon toward its centroid by `gap`, then rounds its corners. */
export function cellPath(polygon: readonly Point[], gap: number, round: number): string {
  const cx = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const cy = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const inset = polygon.map(([x, y]): Point => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    const k = Math.max(0, (d - gap) / d);
    return [cx + (x - cx) * k, cy + (y - cy) * k];
  });
  const f = (n: number): string => (100 + n).toFixed(2);
  return (
    inset
      .map((c, i) => {
        const p = inset[(i - 1 + inset.length) % inset.length];
        const n = inset[(i + 1) % inset.length];
        const toward = (o: Point): Point => {
          const l = Math.hypot(o[0] - c[0], o[1] - c[1]) || 1;
          const k = Math.min(round, l / 2) / l;
          return [c[0] + (o[0] - c[0]) * k, c[1] + (o[1] - c[1]) * k];
        };
        const a = toward(p);
        const b = toward(n);
        return `${i === 0 ? "M" : "L"}${f(a[0])} ${f(a[1])}Q${f(c[0])} ${f(c[1])} ${f(b[0])} ${f(b[1])}`;
      })
      .join("") + "Z"
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Draws the cells into `group` and, unless the viewer prefers reduced motion, cycles the patterns. */
export function mountLogoDisplay(group: SVGGElement, intervalMs = 3200): void {
  const cells = seedCells({ count: SEED_COUNT, radius: 72 });
  const paths = cells.map((cell) => {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", cellPath(cell.polygon, 4, 5));
    path.style.fill = TONES[PATTERNS[0].tone(cell)];
    // The change ripples outward from the centre, like a display refreshing.
    path.style.transition = `fill 900ms cubic-bezier(.4,0,.2,1) ${Math.round(cell.radial * 450)}ms`;
    return path;
  });
  group.replaceChildren(...paths);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let current = 0;
  window.setInterval(() => {
    if (document.hidden) return;
    current = (current + 1) % PATTERNS.length;
    cells.forEach((cell, i) => {
      paths[i].style.fill = TONES[PATTERNS[current].tone(cell)];
    });
  }, intervalMs);
}

if (typeof document !== "undefined") {
  for (const group of document.querySelectorAll<SVGGElement>("[data-logo-display]")) mountLogoDisplay(group);
}
