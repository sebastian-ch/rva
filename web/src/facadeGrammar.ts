/**
 * Split-grammar facade geometry for the lower two floors of street-facing walls.
 *
 * The shader in `facade.ts` paints windows, sills and a cornice; what it cannot give is silhouette.
 * This module emits the projecting geometry the AO and outline passes in `postfx.ts` respond to:
 * a plinth, bay piers, a storefront lintel, awnings, entrances and a second-floor cornice.
 *
 * Only the lower two floors are modelled, because that is all an isometric camera resolves, and only
 * walls that actually front a street, decided from the tile's own road ribbons rather than guessed.
 */
import * as THREE from 'three';
import palette from '../../assets/palette.json';
import { hex } from './props';
import { cleanRing, hashStr, type MeshBuilder, type V2 } from './geomutil';
import { AO_BOTTOM, AO_HEIGHT, STYLE_INDUSTRIAL, STYLE_NONE, STYLE_OFFICE, STYLE_PARKING, STYLE_RESIDENTIAL, STYLE_RETAIL, facadeParams } from './facade';
import type { BuildingProps, Feature, LineGeom, RoadProps } from './types';

type PaletteKey = keyof typeof palette;
const pal = (k: string): THREE.Color => hex((k in palette ? k : 'cream') as PaletteKey);

const UP = new THREE.Vector3(0, 1, 0);
// Scratch vertices: MeshBuilder copies the numbers out of them, so nothing here is retained.
const SCRATCH = [0, 1, 2, 3].map(() => new THREE.Vector3());
const CROSS_A = new THREE.Vector3(), CROSS_B = new THREE.Vector3();
/** A wall is a frontage when a street centreline is this close on its outward side. */
const STREET_REACH = 22;
const CELL = STREET_REACH;
/** Frontages shorter than this read as a return wall, not a shopfront. */
const MIN_FRONTAGE = 6;
const MAX_FRONTAGE = 48;
const FRONTAGES_PER_BUILDING = 2;
/** Per-tile triangle ceiling for the whole grammar. Buildings are visited in tile order, so this is stable. */
export const FACADE_TRI_BUDGET = 20000;

export interface StreetIndex {
  /** Closest point on a street centreline within `STREET_REACH` of p, or null. */
  nearest(p: V2): V2 | null;
}

const EMPTY_STREETS: StreetIndex = { nearest: () => null };

/** Street centrelines of one tile, in local coordinates, in a uniform grid for per-edge lookup. */
export function buildStreetIndex(roads: Feature<LineGeom, RoadProps>[], toLocal: (x: number, y: number) => V2): StreetIndex {
  const segs: [V2, V2][] = [];
  const grid = new Map<string, number[]>();
  const key = (cx: number, cz: number) => `${cx},${cz}`;
  for (const f of roads) {
    const p = f.properties;
    // A tunnel has no frontage; a bridge deck runs past upper floors, not the shopfront.
    if (p.tunnel || p.bridge) continue;
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const line of lines) {
      const c = cleanRing(line).map(([x, y]) => toLocal(x, y));
      for (let i = 0; i < c.length - 1; i++) {
        const a = c[i], b = c[i + 1];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
        const idx = segs.push([a, b]) - 1;
        const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
        const z0 = Math.floor(Math.min(a[1], b[1]) / CELL), z1 = Math.floor(Math.max(a[1], b[1]) / CELL);
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz), bucket = grid.get(k);
          if (bucket) bucket.push(idx); else grid.set(k, [idx]);
        }
      }
    }
  }
  if (!segs.length) return EMPTY_STREETS;
  return {
    nearest(p) {
      const cx = Math.floor(p[0] / CELL), cz = Math.floor(p[1] / CELL);
      let best = STREET_REACH * STREET_REACH, out: V2 | null = null;
      for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
        for (const s of grid.get(key(i, j)) ?? []) {
          const [a, b] = segs[s];
          const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
          const qx = a[0] + t * dx, qz = a[1] + t * dz;
          const d2 = (p[0] - qx) * (p[0] - qx) + (p[1] - qz) * (p[1] - qz);
          if (d2 < best) { best = d2; out = [qx, qz]; }
        }
      }
      return out;
    },
  };
}

interface Frontage { start: V2; dir: V2; nrm: V2; len: number }

/**
 * Outer-ring edges that face a street, longest first. The ring is oriented so the building mass lies to
 * the left of each edge, so the outward normal is the right-hand side — the same convention as the walls.
 */
export function streetFrontages(outer: V2[], streets: StreetIndex): Frontage[] {
  const out: Frontage[] = [];
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    if (len < MIN_FRONTAGE) continue;
    const dir: V2 = [dx / len, dz / len], nrm: V2 = [dz / len, -dx / len];
    const mid: V2 = [a[0] + dx * 0.5 + nrm[0] * 0.5, a[1] + dz * 0.5 + nrm[1] * 0.5];
    const q = streets.nearest(mid);
    if (!q) continue;
    // The street has to be in front of the wall, not behind it or level with it along a return.
    const toStreet = Math.hypot(q[0] - mid[0], q[1] - mid[1]);
    if (toStreet < 1e-6) continue;
    if (((q[0] - mid[0]) * nrm[0] + (q[1] - mid[1]) * nrm[1]) / toStreet < 0.35) continue;
    out.push({ start: a, dir, nrm, len });
  }
  return out.sort((x, y) => y.len - x.len).slice(0, FRONTAGES_PER_BUILDING);
}

/** Geometry emitter in one frontage's frame: u along the wall, y above ground, d out from the wall plane. */
class Wall {
  private readonly sunFront: number;
  private readonly sunSide: number;
  private readonly sunSideBack: number;
  private readonly nF: THREE.Vector3;
  private readonly nS: THREE.Vector3;
  private readonly nSBack: THREE.Vector3;
  constructor(
    private readonly mb: MeshBuilder,
    private readonly fr: Frontage,
    private readonly ground: number,
    private readonly base: number,
    private readonly height: number,
  ) {
    this.sunFront = sun(fr.nrm[0], fr.nrm[1]);
    this.sunSide = sun(fr.dir[0], fr.dir[1]);
    this.sunSideBack = sun(-fr.dir[0], -fr.dir[1]);
    this.nF = new THREE.Vector3(fr.nrm[0], 0, fr.nrm[1]);
    this.nS = new THREE.Vector3(fr.dir[0], 0, fr.dir[1]);
    this.nSBack = this.nS.clone().negate();
  }
  private v(slot: number, u: number, d: number, y: number): THREE.Vector3 {
    return SCRATCH[slot].set(
      this.fr.start[0] + this.fr.dir[0] * u + this.fr.nrm[0] * d,
      this.ground + y,
      this.fr.start[1] + this.fr.dir[1] * u + this.fr.nrm[1] * d,
    );
  }
  /** One quad in the frontage frame, from four (u, d, y) corners. */
  private face(
    c0: [number, number, number], c1: [number, number, number], c2: [number, number, number], c3: [number, number, number],
    color: THREE.Color, n: THREE.Vector3, shade: number,
  ): void {
    const a = this.v(0, c0[0], c0[1], c0[2]), b = this.v(1, c1[0], c1[1], c1[2]);
    const c = this.v(2, c2[0], c2[1], c2[2]), d = this.v(3, c3[0], c3[1], c3[2]);
    this.quad(a, b, c, d, color, n, shade);
  }
  /** Wall vertex shade at height y, matching the gradient baked into the wall quads. */
  private shade(y: number): number {
    const sBot = this.height > AO_HEIGHT ? AO_BOTTOM : THREE.MathUtils.lerp(1, AO_BOTTOM, this.height / AO_HEIGHT);
    return THREE.MathUtils.lerp(sBot, 1, Math.min(1, (y - this.base) / (this.height - this.base)));
  }
  private quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color, n: THREE.Vector3, shade: number): void {
    const cross = CROSS_A.subVectors(b, a).cross(CROSS_B.subVectors(c, a));
    if (cross.dot(n) < 0) { this.mb.tri(a, c, b, color, n, shade); this.mb.tri(a, d, c, color, n, shade); }
    else { this.mb.tri(a, b, c, color, n, shade); this.mb.tri(a, c, d, color, n, shade); }
  }
  /** Flat 2-triangle panel on the wall plane: glazing and doors, which have no depth of their own. */
  panel(u0: number, u1: number, y0: number, y1: number, d: number, color: THREE.Color, tint = 1): void {
    this.face([u0, d, y0], [u1, d, y0], [u1, d, y1], [u0, d, y1], color, this.nF, this.sunFront * this.shade(y1) * tint);
  }
  /**
   * Projecting slab: front, top and the two returns. The back is inside the wall and the underside is
   * never visible to a camera that looks down, so four faces is the whole silhouette.
   */
  slab(u0: number, u1: number, y0: number, y1: number, d: number, color: THREE.Color, tint = 1, capped = true): void {
    const s = this.shade(y1) * tint;
    this.face([u0, d, y0], [u1, d, y0], [u1, d, y1], [u0, d, y1], color, this.nF, this.sunFront * s);
    // The top is dropped where another band sits directly on it; nothing can see between them.
    if (capped) this.face([u0, 0, y1], [u1, 0, y1], [u1, d, y1], [u0, d, y1], color, UP, 1.04 * s);
    this.face([u0, 0, y0], [u0, d, y0], [u0, d, y1], [u0, 0, y1], color, this.nSBack, this.sunSideBack * 0.9 * s);
    this.face([u1, 0, y0], [u1, d, y0], [u1, d, y1], [u1, 0, y1], color, this.nS, this.sunSide * 0.9 * s);
  }
}

/** Same fake directional term the wall quads use, so attached geometry lights consistently. */
function sun(nx: number, nz: number): number {
  return 0.92 + 0.08 * Math.max(0, nx * 0.6 + nz * 0.8);
}

interface Rule {
  bay: number;
  /** Plinth height, 0 for none. */
  plinth: number;
  /** What fills a bay: full-height glazing, a punched window with a sill and head, or nothing. */
  bays: 'shopfront' | 'punched' | 'open';
  /** Glazing head as a fraction of the ground floor. */
  glazing: number;
  awnings: boolean;
  door: 'shopfront' | 'stoop' | 'roller' | 'none';
  cornice: boolean;
}

function ruleFor(style: number): Rule | null {
  switch (style) {
    case STYLE_RETAIL: return { bay: 5, plinth: 0.35, bays: 'shopfront', glazing: 0.82, awnings: true, door: 'shopfront', cornice: true };
    case STYLE_OFFICE: return { bay: 4, plinth: 0.8, bays: 'shopfront', glazing: 0.74, awnings: false, door: 'shopfront', cornice: true };
    case STYLE_RESIDENTIAL: return { bay: 4.4, plinth: 0.5, bays: 'punched', glazing: 0, awnings: false, door: 'stoop', cornice: true };
    case STYLE_INDUSTRIAL: return { bay: 7, plinth: 0.4, bays: 'punched', glazing: 0, awnings: false, door: 'roller', cornice: false };
    // A garage's street level is open deck between piers: no glazing, no entrance, no cornice.
    case STYLE_PARKING: return { bay: 5.5, plinth: 0.9, bays: 'open', glazing: 0, awnings: false, door: 'none', cornice: false };
    default: return null;
  }
}

const AWNING_COLORS = ['terracotta', 'roof_green', 'slate', 'brick_dark'];

/**
 * Emit the grammar for one building's street frontages. Returns the triangle count, which the caller
 * charges against the tile budget.
 */
export function addStreetFacade(
  mb: MeshBuilder,
  outer: V2[],
  ground: number,
  p: BuildingProps,
  streets: StreetIndex,
  budget: { left: number },
): number {
  if (budget.left <= 0) return 0;
  // Parts that start above the pavement have no ground floor of their own.
  if (p.min_height > 0.5) return 0;
  const fp = facadeParams(p);
  if (fp.style === STYLE_NONE || fp.floor <= 0) return 0;
  const rule = ruleFor(fp.style);
  if (!rule) return 0;
  const frontages = streetFrontages(outer, streets);
  if (!frontages.length) return 0;

  const start = mb.triCount;
  const seed = (hashStr(p.id) % 1000) / 1000;
  const base = -0.3 + p.min_height;
  const floor = Math.min(fp.floor, 4.8);
  const gf = Math.min(floor, p.height - 0.4);
  if (gf < 2.2) return 0;

  frontages.forEach((fr, index) => {
    const wall = new Wall(mb, fr, ground, base, p.height);
    const color = pal(p.wall_color);
    const trim = color.clone().multiplyScalar(1.05);
    const plinth = color.clone().multiplyScalar(0.86);
    const glass = pal('glass');
    const span = Math.min(fr.len, MAX_FRONTAGE);
    const u0 = (fr.len - span) / 2;
    const bays = Math.max(1, Math.round(span / rule.bay));
    const bayW = span / bays;
    const pier = Math.min(0.42, bayW * 0.18);
    // The entrance goes in the middle of the primary frontage; a side street gets shopfront only.
    const doorBay = index === 0 && rule.door !== 'none' ? Math.floor(bays / 2) : -1;

    if (rule.plinth > 0) wall.slab(u0, u0 + span, 0, rule.plinth, 0.12, plinth);
    // Bay piers, then the lintel band that closes the ground floor.
    for (let i = 0; i <= bays; i++) {
      const c = u0 + i * bayW;
      wall.slab(Math.max(u0, c - pier / 2), Math.min(u0 + span, c + pier / 2), 0, gf, 0.17, trim, 1, false);
    }
    wall.slab(u0, u0 + span, gf - 0.3, gf, 0.32, trim);

    for (let i = 0; i < bays; i++) {
      const a = u0 + i * bayW + pier / 2, b = u0 + (i + 1) * bayW - pier / 2;
      if (b - a < 0.6) continue;
      if (i === doorBay) {
        addEntrance(wall, a, b, gf, rule.door, color, trim, glass);
        continue;
      }
      if (rule.bays === 'open') continue;
      if (rule.bays === 'shopfront') {
        wall.panel(a, b, rule.plinth + 0.1, gf * rule.glazing, 0.05, glass, 0.9);
        // A seeded subset carries awnings, so a retail block varies along its length.
        // Awnings only on the primary frontage: a side elevation on the cross street is plainer, and
        // they are the most expensive optional element in the set.
        if (rule.awnings && index === 0 && gf > 3 && fract(seed * 17.3 + i * 0.61) > 0.45) {
          const awning = pal(AWNING_COLORS[Math.floor(fract(seed * 7.1 + i * 0.37) * AWNING_COLORS.length)]);
          wall.slab(a, b, gf * rule.glazing, gf * rule.glazing + 0.5, 0.95, awning);
        }
      } else {
        // Punched window: the shader draws the opening, the geometry gives it a sill and a head.
        const w = Math.min(1.6, (b - a) * 0.6), c = (a + b) / 2;
        wall.slab(c - w / 2, c + w / 2, gf * 0.28, gf * 0.34, 0.14, trim);
        wall.slab(c - w / 2 - 0.12, c + w / 2 + 0.12, gf * 0.76, gf * 0.84, 0.12, trim);
      }
    }

    // A cornice at the second-floor line, where a third floor actually rises above it. The sill course
    // the shader paints is left to the shader: a band of its own is not worth its triangles at map scale.
    if (rule.cornice && p.height > floor * 2 + 1.2) wall.slab(u0, u0 + span, floor * 2 - 0.35, floor * 2, 0.38, trim);
  });

  const emitted = mb.triCount - start;
  budget.left -= emitted;
  return emitted;
}

function fract(x: number): number { return x - Math.floor(x); }

function addEntrance(wall: Wall, a: number, b: number, gf: number, kind: Rule['door'], color: THREE.Color, trim: THREE.Color, glass: THREE.Color): void {
  const width = Math.min(2.6, b - a), c = (a + b) / 2;
  const d0 = c - width / 2, d1 = c + width / 2;
  const head = Math.min(gf - 0.45, 2.6);
  const door = pal('shadow');
  if (kind === 'roller') {
    wall.panel(d0 - 0.6, d1 + 0.6, 0, head, 0.04, pal('steel'), 0.85);
    wall.slab(d0 - 0.75, d1 + 0.75, head, head + 0.3, 0.3, trim);
    return;
  }
  // Frame both jambs and the head, then set the leaves behind them so the opening reads as recessed.
  wall.panel(d0, d1, 0, head, 0.03, door, 0.8);
  wall.slab(d0 - 0.22, d0, 0, head + 0.22, 0.24, trim);
  wall.slab(d1, d1 + 0.22, 0, head + 0.22, 0.24, trim);
  wall.slab(d0 - 0.22, d1 + 0.22, head, head + 0.22, 0.26, trim);
  if (kind === 'shopfront') {
    wall.panel(d0 + 0.12, d1 - 0.12, 0.1, head - 0.25, 0.05, glass, 0.95);
    if (gf > head + 0.9) wall.slab(d0 - 0.5, d1 + 0.5, head + 0.5, head + 0.68, 1.1, trim);
  } else {
    // Stoop: two steps to the threshold and a small canopy on the door head.
    wall.slab(d0 - 0.35, d1 + 0.35, 0, 0.18, 1.0, color.clone().multiplyScalar(0.9));
    wall.slab(d0 - 0.2, d1 + 0.2, 0.18, 0.36, 0.62, color.clone().multiplyScalar(0.94));
    wall.slab(d0 - 0.45, d1 + 0.45, head + 0.22, head + 0.4, 1.0, trim);
  }
}
