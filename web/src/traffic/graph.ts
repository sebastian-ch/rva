/**
 * Road graph for the traffic simulation. Pure TypeScript (no three.js) so it runs in a worker and in tests.
 *
 * Tiles hand over car paths (local-frame 3D polylines, x east / y up / z = -north) plus per-path meta. Every
 * polyline becomes one directed edge per travel direction. Nodes are keyed by snapped (x, z) so a street clipped
 * at a tile border becomes one node shared by both halves once both tiles are loaded, and a side street ending
 * on an interior vertex of a through road splits that road at the vertex.
 */

export interface CarPathMeta {
  oneway: boolean;
  width: number;
  highway: string;
  lanes: number;
  bridge: boolean;
  ramp: boolean;
  wayId: string;
}

export interface Edge {
  id: number;
  /** forward and reverse edge of the same polyline share a pair id */
  pair: number;
  tileId: string;
  wayId: string;
  highway: string;
  link: boolean;
  from: string;
  to: string;
  /** x, y, z triples */
  pts: Float32Array;
  /** cumulative arc length per vertex */
  cum: Float32Array;
  length: number;
  /** speed limit, m/s */
  v0: number;
  priority: number;
  width: number;
  laneOffset: number;
  /** vehicle ids on this edge, kept sorted by arc length by the sim */
  vehicles: number[];
}

export interface Node {
  key: string;
  x: number;
  z: number;
  in: number[];
  out: number[];
}

const SNAP = 0.25; // m

export function nodeKey(x: number, z: number): string {
  return `${Math.round(x / SNAP)}|${Math.round(z / SNAP)}`;
}

/** Speed limit (m/s) by OSM highway class. */
export function speedLimit(highway: string): number {
  switch (highway) {
    case 'motorway': return 27;
    case 'trunk': return 22;
    case 'primary': return 15;
    case 'secondary': return 13;
    case 'tertiary': return 11;
    case 'motorway_link': return 16;
    case 'trunk_link': return 14;
    case 'primary_link': return 11;
    case 'secondary_link': return 10;
    case 'tertiary_link': return 9;
    default: return 8;
  }
}

/** Right-of-way rank; ramps (links) yield to the class they join. */
export function priority(highway: string): number {
  switch (highway) {
    case 'motorway': return 5;
    case 'trunk': return 4;
    case 'primary': return 3;
    case 'secondary': return 2;
    case 'tertiary': return 1;
    case 'motorway_link': return 3;
    case 'trunk_link': return 2;
    case 'primary_link': return 1;
    default: return 0;
  }
}

/** Centre of the right-hand lane: a quarter of the roadway, clamped to a sane lane width. */
export function laneOffset(width: number): number {
  return Math.min(2.4, Math.max(1.4, width / 4));
}

export class RoadGraph {
  readonly edges = new Map<number, Edge>();
  readonly nodes = new Map<string, Node>();
  private byTile = new Map<string, number[]>();
  private nextId = 0;
  private nextPair = 0;

  /** Add a tile's car paths. `paths` are flat x,y,z triples. Returns the new edge ids. */
  addTile(tileId: string, paths: Float32Array[], meta: CarPathMeta[]): number[] {
    if (this.byTile.has(tileId)) this.removeTile(tileId);
    // split keys: every existing node, every path endpoint, and every vertex shared by two paths (OSM ways
    // usually cross at a shared interior node rather than ending there)
    const splitKeys = new Set<string>(this.nodes.keys());
    const seen = new Map<string, number>();
    for (const p of paths) {
      if (p.length < 6) continue;
      splitKeys.add(nodeKey(p[0], p[2]));
      splitKeys.add(nodeKey(p[p.length - 3], p[p.length - 1]));
      const own = new Set<string>();
      for (let i = 0; i < p.length; i += 3) own.add(nodeKey(p[i], p[i + 2]));
      for (const k of own) seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, n] of seen) if (n >= 2) splitKeys.add(k);
    const ids: number[] = [];
    paths.forEach((p, i) => {
      if (p.length < 6) return;
      const m = meta[i] ?? { oneway: false, width: 7, highway: 'residential', lanes: 2, bridge: false, ramp: false, wayId: `${tileId}:${i}` };
      for (const piece of splitAt(p, splitKeys)) {
        if (piece.length < 6 || pathLength(piece) < 1) continue;
        ids.push(this.addEdge(tileId, piece, m).id);
        if (!m.oneway) ids.push(this.addEdge(tileId, reversed(piece), m, this.nextPair - 1).id);
      }
    });
    this.byTile.set(tileId, ids);
    return ids;
  }

  /** Remove a tile's edges (and detach them from their nodes). Returns the removed edge ids. */
  removeTile(tileId: string): number[] {
    const ids = this.byTile.get(tileId) ?? [];
    for (const id of ids) {
      const e = this.edges.get(id);
      if (!e) continue;
      this.edges.delete(id);
      for (const [key, list] of [[e.from, 'out'], [e.to, 'in']] as const) {
        const n = this.nodes.get(key);
        if (!n) continue;
        const arr = n[list];
        const k = arr.indexOf(id);
        if (k >= 0) arr.splice(k, 1);
        if (!n.in.length && !n.out.length) this.nodes.delete(key);
      }
    }
    this.byTile.delete(tileId);
    return ids;
  }

  private addEdge(tileId: string, pts: Float32Array, m: CarPathMeta, pair?: number): Edge {
    const cum = cumulative(pts);
    const from = this.node(pts[0], pts[2]), to = this.node(pts[pts.length - 3], pts[pts.length - 1]);
    const e: Edge = {
      id: this.nextId++, pair: pair ?? this.nextPair++, tileId, wayId: m.wayId, highway: m.highway, link: m.highway.endsWith('_link'),
      from: from.key, to: to.key, pts, cum, length: cum[cum.length - 1], v0: speedLimit(m.highway), priority: priority(m.highway),
      width: m.width, laneOffset: laneOffset(m.width), vehicles: [],
    };
    this.edges.set(e.id, e);
    from.out.push(e.id);
    to.in.push(e.id);
    return e;
  }

  private node(x: number, z: number): Node {
    const key = nodeKey(x, z);
    let n = this.nodes.get(key);
    if (!n) { n = { key, x, z, in: [], out: [] }; this.nodes.set(key, n); }
    return n;
  }

  /** Number of distinct undirected arms at a node (forward/reverse of one polyline count once). */
  arms(key: string): number {
    const n = this.nodes.get(key);
    if (!n) return 0;
    const pairs = new Set<number>();
    for (const id of n.in) { const e = this.edges.get(id); if (e) pairs.add(e.pair); }
    for (const id of n.out) { const e = this.edges.get(id); if (e) pairs.add(e.pair); }
    return pairs.size;
  }

  /** Edges a vehicle may continue onto after `e`; the reverse of `e` only when nothing else exists. */
  outgoing(e: Edge): Edge[] {
    const n = this.nodes.get(e.to);
    if (!n) return [];
    const out: Edge[] = [];
    let back: Edge | null = null;
    for (const id of n.out) {
      const o = this.edges.get(id);
      if (!o) continue;
      if (o.pair === e.pair) back = o;
      else out.push(o);
    }
    return out.length ? out : back ? [back] : [];
  }

  /** Heading (unit x,z) of an edge at its start or end. */
  dirAt(e: Edge, atEnd: boolean): [number, number] {
    const p = e.pts;
    const i = atEnd ? p.length - 6 : 0, j = atEnd ? p.length - 3 : 3;
    const dx = p[j] - p[i], dz = p[j + 2] - p[i + 2];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  }

  /** Turn angle in degrees when leaving `a` onto `b` (0 = straight on). */
  turnAngle(a: Edge, b: Edge): number {
    const [ax, az] = this.dirAt(a, true), [bx, bz] = this.dirAt(b, false);
    const c = Math.max(-1, Math.min(1, ax * bx + az * bz));
    return (Math.acos(c) * 180) / Math.PI;
  }

  /** Position and heading at arc length s along the edge, offset into the right-hand lane. */
  poseAt(e: Edge, s: number, out: Float32Array, o: number): void {
    const cum = e.cum, p = e.pts;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1];
    const f = seg > 0 ? Math.min(1, Math.max(0, (s - cum[i - 1]) / seg)) : 0;
    const a = (i - 1) * 3, b = i * 3;
    const dx = p[b] - p[a], dz = p[b + 2] - p[a + 2];
    const l = Math.hypot(dx, dz) || 1;
    // right-hand lane: +x by dz, -z by dx (same convention as the old prop pool)
    out[o] = p[a] + dx * f + (dz / l) * e.laneOffset;
    out[o + 1] = p[a + 1] + (p[b + 1] - p[a + 1]) * f + 0.05;
    out[o + 2] = p[a + 2] + dz * f - (dx / l) * e.laneOffset;
    out[o + 3] = Math.atan2(-dz, dx);
  }
}

export function pathLength(p: Float32Array): number {
  let l = 0;
  for (let i = 3; i < p.length; i += 3) l += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2], p[i + 2] - p[i - 1]);
  return l;
}

function cumulative(p: Float32Array): Float32Array {
  const n = p.length / 3;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    cum[i] = cum[i - 1] + Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
  }
  return cum;
}

function reversed(p: Float32Array): Float32Array {
  const n = p.length / 3;
  const out = new Float32Array(p.length);
  for (let i = 0; i < n; i++) { const s = (n - 1 - i) * 3, d = i * 3; out[d] = p[s]; out[d + 1] = p[s + 1]; out[d + 2] = p[s + 2]; }
  return out;
}

/** Split a polyline at interior vertices whose snapped key is in `keys`. */
export function splitAt(p: Float32Array, keys: Set<string>): Float32Array[] {
  const n = p.length / 3;
  const cuts: number[] = [0];
  for (let i = 1; i < n - 1; i++) if (keys.has(nodeKey(p[i * 3], p[i * 3 + 2]))) cuts.push(i);
  cuts.push(n - 1);
  const out: Float32Array[] = [];
  for (let c = 1; c < cuts.length; c++) {
    const a = cuts[c - 1], b = cuts[c];
    if (b <= a) continue;
    out.push(p.slice(a * 3, (b + 1) * 3));
  }
  return out;
}
