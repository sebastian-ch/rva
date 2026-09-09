import * as THREE from 'three';
import { hex } from './props';
import { MeshBuilder, cleanRing, type V2 } from './geomutil';
import type { CrossingProps, Feature, LineGeom, PointGeom, RailProps, RoadProps } from './types';

const UP = new THREE.Vector3(0, 1, 0);

const ROAD_Y = 0.28; // road surface above terrain; land drapes sit at 0.08 so roads always win on slopes
const SEG = 8;        // resample step (m), same as the land drape subdivision

const MINOR = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'service', 'living_street', 'track']);
/** Unpaved trails (Belle Isle, riverbank): drawn in dirt colour, no cars, no sidewalks. */
const TRAIL = new Set(['path', 'track']);
const FOOT_MINOR = new Set(['footway', 'pedestrian', 'path']);
/** Grade-separated roads and ramps: no sidewalk strips, no junction corner fills, only a narrow deck edge. */
const NO_WALK = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

function lines(g: LineGeom): V2[][] {
  return g.type === 'LineString' ? [g.coordinates as V2[]] : (g.coordinates as V2[][]);
}

/** Emit a flat ribbon along a polyline with mitered joins. Points are local (x, z) + per-point y. */
/**
 * Flat strip along a 3D path. `edgeY(x, z, yCentre)` optionally re-heights each edge vertex: draped roads pass
 * a ground lookup so the ribbon never sinks under terrain that slopes across it (cut walls beside a sunken
 * freeway); decks leave it out and stay level.
 */
function ribbon(mb: MeshBuilder, pts: THREE.Vector3[], halfW: number, color: THREE.Color, shade = 1, edgeY?: (x: number, z: number, y: number) => number) {
  const n = pts.length;
  if (n < 2) return;
  const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    const d = new THREE.Vector3(next.x - prev.x, 0, next.z - prev.z).normalize();
    // miter: average of adjacent segment directions, clamp widening
    let nx = -d.z, nz = d.x, w = halfW;
    if (i > 0 && i < n - 1) {
      const d0 = new THREE.Vector3(pts[i].x - prev.x, 0, pts[i].z - prev.z).normalize();
      const d1 = new THREE.Vector3(next.x - pts[i].x, 0, next.z - pts[i].z).normalize();
      const m = new THREE.Vector3().addVectors(d0, d1).normalize();
      nx = -m.z; nz = m.x;
      const cos = m.dot(d0);
      w = halfW / Math.max(0.5, cos);
    }
    const lx = pts[i].x + nx * w, lz = pts[i].z + nz * w, rx = pts[i].x - nx * w, rz = pts[i].z - nz * w;
    left.push(new THREE.Vector3(lx, edgeY ? edgeY(lx, lz, pts[i].y) : pts[i].y, lz));
    right.push(new THREE.Vector3(rx, edgeY ? edgeY(rx, rz, pts[i].y) : pts[i].y, rz));
  }
  for (let i = 0; i < n - 1; i++) {
    const a = left[i], b = right[i], c = right[i + 1], d = left[i + 1];
    const cr = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (cr.y >= 0) { mb.tri(a, b, c, color, UP, shade); mb.tri(a, c, d, color, UP, shade); }
    else { mb.tri(a, c, b, color, UP, shade); mb.tri(a, d, c, color, UP, shade); }
  }
}

/** Dashed line along a path: `dash` m on, `gap` m off. */
function dashes(mb: MeshBuilder, pts: THREE.Vector3[], halfW: number, color: THREE.Color, dash = 3, gap = 6, offset = 0) {
  let carry = offset;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = a.distanceTo(b);
    if (len < 1e-6) continue;
    let t = carry;
    while (t < len) {
      const s0 = Math.max(0, t), s1 = Math.min(len, t + dash);
      if (s1 > s0) ribbon(mb, [a.clone().lerp(b, s0 / len), a.clone().lerp(b, s1 / len)], halfW, color);
      t += dash + gap;
    }
    carry = t - len;
  }
}

/** Offset a path sideways by `off` meters (positive = left of travel). */
function offsetPath(pts: THREE.Vector3[], off: number): THREE.Vector3[] {
  const n = pts.length, out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    const d = new THREE.Vector3(next.x - prev.x, 0, next.z - prev.z).normalize();
    out.push(new THREE.Vector3(pts[i].x - d.z * off, pts[i].y, pts[i].z + d.x * off));
  }
  return out;
}

/** Bridge furniture: railings on both edges and box piers to the ground every ~25 m. */
function bridgeFurniture(mb: MeshBuilder, path: THREE.Vector3[], halfW: number, groundY: (v: THREE.Vector3) => number, color: THREE.Color) {
  for (const side of [1, -1]) {
    const rail = offsetPath(path, side * (halfW - 0.3));
    for (let i = 0; i < rail.length - 1; i++) {
      const a = rail[i], b = rail[i + 1];
      if (a.y - groundY(a) < 1.5 && b.y - groundY(b) < 1.5) continue; // at grade: no railing
      const a2 = a.clone().setY(a.y + 1.0), b2 = b.clone().setY(b.y + 1.0);
      const n = new THREE.Vector3().subVectors(b, a).cross(UP).normalize().multiplyScalar(side);
      mb.tri(a, b, b2, color, n, 0.9); mb.tri(a, b2, a2, color, n, 0.9);
      mb.tri(a, b2, b, color, n.clone().negate(), 0.9); mb.tri(a, a2, b2, color, n.clone().negate(), 0.9);
    }
  }
  let acc = 12;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const len = a.distanceTo(b);
    let t = 0;
    while (t < len) {
      const step = Math.min(len - t, 5);
      t += step; acc += step;
      if (acc >= 25) {
        acc = 0;
        const c = a.clone().lerp(b, t / len);
        const g = groundY(c);
        if (c.y - g < 1.5) continue;
        const d = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
        pierBox(mb, c, g, d, Math.max(1.2, halfW * 0.5), 1.4, color);
      }
    }
  }
}

function pierBox(mb: MeshBuilder, top: THREE.Vector3, groundY: number, dir: THREE.Vector3, hw: number, hd: number, color: THREE.Color) {
  const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const corner = (sx: number, sz: number, y: number) => new THREE.Vector3(top.x + side.x * sx * hw + dir.x * sz * hd, y, top.z + side.z * sx * hw + dir.z * sz * hd);
  const y0 = groundY - 0.5, y1 = top.y - 0.2;
  const faces: [number, number, number, number][] = [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]];
  for (const [ax, az, bx, bz] of faces) {
    const a = corner(ax, az, y0), b = corner(bx, bz, y0), c = corner(bx, bz, y1), d = corner(ax, az, y1);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
    const out = new THREE.Vector3((a.x + b.x) / 2 - top.x, 0, (a.z + b.z) / 2 - top.z);
    if (n.dot(out) < 0) { mb.tri(a, c, b, color, n.negate(), 0.8); mb.tri(a, d, c, color, n, 0.8); }
    else { mb.tri(a, b, c, color, n, 0.8); mb.tri(a, c, d, color, n, 0.8); }
  }
}

/** Bridge deck: straight line between the way's two bank elevations (from the pipeline's `deck`). */
export interface Deck { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }
export function parseDeck(raw: string | number[] | null | undefined): Deck | null {
  if (!raw) return null;
  try {
    // the GeoJSON driver round-trips the pipeline's JSON string back into a real array
    const a = (Array.isArray(raw) ? raw : JSON.parse(raw)) as number[];
    if (!Array.isArray(a) || a.length !== 6 || a.some((v) => !Number.isFinite(v))) return null;
    return { x0: a[0], y0: a[1], z0: a[2], x1: a[3], y1: a[4], z1: a[5] };
  } catch { return null; }
}
export function deckHeight(d: Deck, x: number, y: number): number {
  const dx = d.x1 - d.x0, dy = d.y1 - d.y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-6 ? THREE.MathUtils.clamp(((x - d.x0) * dx + (y - d.y0) * dy) / len2, 0, 1) : 0;
  return d.z0 + (d.z1 - d.z0) * t;
}
/**
 * Deck thickness above the anchor elevations. The anchors are the abutment tops (the DEM carries embankments),
 * so a bridge meets its approach road at grade; clearance under the span comes from the terrain dropping away.
 */
export function bridgeLift(_layer: number): number { return 0.6; }

/** Resample a polyline so long segments follow terrain (or a bridge deck); returns local 3D points. */
function toPath(coords: V2[], toLocal: (x: number, y: number) => V2, groundAt: (x: number, y: number) => number, lift: number, maxSeg = 12, deck: Deck | null = null): THREE.Vector3[] {
  const c = cleanRing(coords);
  if (c.length < 2) return [];
  const out: THREE.Vector3[] = [];
  const heightAt = deck ? (x: number, y: number) => Math.max(deckHeight(deck, x, y), groundAt(x, y) - 1) : groundAt;
  const push = (x: number, y: number) => { const [lx, lz] = toLocal(x, y); out.push(new THREE.Vector3(lx, heightAt(x, y) + lift, lz)); };
  for (let i = 0; i < c.length - 1; i++) {
    const [x0, y0] = c[i], [x1, y1] = c[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len / maxSeg));
    for (let s = 0; s < steps; s++) { const t = s / steps; push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t); }
  }
  push(c[c.length - 1][0], c[c.length - 1][1]);
  // note: cleanRing drops a closing duplicate; re-add for loops
  if (coords.length > 2) {
    const f = coords[0], l = coords[coords.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) push(f[0], f[1]);
  }
  return out;
}

export type { CarPathMeta } from './traffic/graph';
import type { CarPathMeta } from './traffic/graph';
export interface RoadMeshes { roads: THREE.BufferGeometry; paths: THREE.Vector3[][]; pathMeta: CarPathMeta[]; walkPaths: THREE.Vector3[][]; }

export function buildRoads(
  feats: Feature<LineGeom, RoadProps>[],
  rails: Feature<LineGeom, RailProps>[],
  crossings: Feature<PointGeom, CrossingProps>[],
  toLocal: (x: number, y: number) => V2,
  groundAt: (x: number, y: number) => number,
  opts: { markings?: boolean; bridges?: boolean } = {},
): RoadMeshes {
  const mb = new MeshBuilder();
  // recover the projected origin from toLocal so bridge piers can sample terrain from local coords
  const [ox0, oz0] = toLocal(0, 0);
  const originX = -ox0, originY = oz0;
  const asphalt = hex('asphalt'), paint = hex('lane_paint'), sidewalk = hex('sidewalk'), railC = hex('rail'), concrete = hex('concrete'), dirt = hex('sand');
  const groundLocal = (lx: number, lz: number) => groundAt(lx + originX, -lz + originY);
  /** edge re-heighting for draped strips: never below the ground under the edge plus the strip's lift */
  const draped = (lift: number) => (x: number, z: number, y: number) => Math.max(y, groundLocal(x, z) + lift);
  const carPaths: THREE.Vector3[][] = [];
  const carMeta: CarPathMeta[] = [];
  const walkPaths: THREE.Vector3[][] = [];
  const roadPaths: { path: THREE.Vector3[]; width: number }[] = [];

  // junctions: endpoints shared by >= 2 road polylines get a disc at the widest half width
  // Junctions: every polyline endpoint shared by two or more ways. Asphalt ends are extended into the node by
  // the widest crossing road's half width (square fill, no discs); sidewalk strips are shortened by the same
  // amount plus the sidewalk width so they stop at the corner.
  const junctions = new Map<string, { pt: THREE.Vector3; ends: { dir: THREE.Vector2; halfW: number; walk: boolean }[] }>();
  const key = (x: number, y: number) => `${x.toFixed(1)}|${y.toFixed(1)}`;
  for (const f of feats) {
    const p = f.properties;
    if (p.tunnel || MINOR.has(p.highway)) continue;
    for (const l of lines(f.geometry)) {
      const c = cleanRing(l);
      if (c.length < 2) continue;
      // every vertex registers its outgoing directions: endpoints one, interior vertices two, so a side street
      // ending on a through road's interior node (the usual OSM T-junction) sees the through road there
      const arms: [V2, V2][] = [[c[0], c[1]], [c[c.length - 1], c[c.length - 2]]];
      for (let i = 1; i < c.length - 1; i++) arms.push([c[i], c[i - 1]], [c[i], c[i + 1]]);
      for (const [end, next] of arms) {
        const k = key(end[0], end[1]);
        const [lx, lz] = toLocal(end[0], end[1]);
        const j = junctions.get(k) ?? { pt: new THREE.Vector3(lx, groundAt(end[0], end[1]), lz), ends: [] };
        j.ends.push({ dir: new THREE.Vector2(next[0] - end[0], next[1] - end[1]).normalize(), halfW: p.width / 2, walk: !NO_WALK.has(p.highway) });
        junctions.set(k, j);
      }
    }
  }
  /** Half width of the widest *other* road meeting at this end, or 0 when the end is free / a continuation. */
  const otherHalfW = (pt: V2, myHalfW: number, myDir: V2): number => {
    const j = junctions.get(key(pt[0], pt[1]));
    if (!j || j.ends.length < 2) return 0;
    let best = 0;
    for (const e of j.ends) {
      const cos = e.dir.x * myDir[0] + e.dir.y * myDir[1];
      if (cos > 0.999 && Math.abs(e.halfW - myHalfW) < 0.05) continue; // this way itself
      if (cos < -0.98 && Math.abs(e.halfW - myHalfW) < 0.3) continue;  // straight continuation, same width
      best = Math.max(best, e.halfW);
    }
    return best;
  };
  const endDirs = (c: V2[]): [V2, V2] => {
    const n = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };
    return [n([c[1][0] - c[0][0], c[1][1] - c[0][1]]), n([c[c.length - 2][0] - c[c.length - 1][0], c[c.length - 2][1] - c[c.length - 1][1]])];
  };
  /** Move both ends of a local path along their segment by delta (positive = outward/extend). */
  const adjustEnds = (path: THREE.Vector3[], d0: number, d1: number): THREE.Vector3[] => {
    if (path.length < 2) return path;
    const out = path.map((v) => v.clone());
    const move = (a: THREE.Vector3, b: THREE.Vector3, delta: number) => {
      const dir = new THREE.Vector3(a.x - b.x, 0, a.z - b.z);
      const len = dir.length();
      if (len < 1e-6) return;
      dir.divideScalar(len);
      a.addScaledVector(dir, Math.max(delta, -(len - 0.5)));
    };
    move(out[0], out[1], d0);
    move(out[out.length - 1], out[out.length - 2], d1);
    return out;
  };
  const CURB = 0.15, WALK_W = 2.2, WALK_Y = ROAD_Y + CURB, DECK_EDGE = 0.5;

  // sidewalks: raised strips either side with a curb face; bridges keep a wide concrete deck instead
  for (const f of feats) {
    const p = f.properties;
    if (p.tunnel || MINOR.has(p.highway)) continue;
    const lift = p.bridge ? bridgeLift(p.layer) : 0;
    const deck = p.bridge ? parseDeck(p.deck) : null;
    for (const l of lines(f.geometry)) {
      const c = cleanRing(l);
      if (c.length < 2) continue;
      const walk = !NO_WALK.has(p.highway);
      if (p.bridge || p.ramp) {
        const rdeck = p.bridge ? deck : parseDeck(p.deck);
        ribbon(mb, toPath(l, toLocal, groundAt, ROAD_Y - 0.06 + lift, SEG, rdeck), p.width / 2 + (walk ? WALK_W : DECK_EDGE), concrete, 0.98);
        continue;
      }
      if (!walk) continue;
      const [d0, d1] = endDirs(c);
      const o0 = otherHalfW(c[0], p.width / 2, d0), o1 = otherHalfW(c[c.length - 1], p.width / 2, d1);
      const base = toPath(l, toLocal, groundAt, WALK_Y);
      const path = adjustEnds(base, -(o0 ? o0 + WALK_W : 0), -(o1 ? o1 + WALK_W : 0));
      if (path.length < 2) continue;
      for (const side of [1, -1]) {
        const strip = offsetPath(path, side * (p.width / 2 + WALK_W / 2));
        ribbon(mb, strip, WALK_W / 2, sidewalk, 0.98, draped(WALK_Y));
        walkPaths.push(strip);
        const inner = offsetPath(path, side * (p.width / 2));
        for (let i = 0; i < inner.length - 1; i++) {
          const a = inner[i], b = inner[i + 1];
          const a2 = a.clone().setY(a.y - CURB - 0.02), b2 = b.clone().setY(b.y - CURB - 0.02);
          const n = new THREE.Vector3().subVectors(b, a).cross(UP).normalize().multiplyScalar(-side);
          const cr = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(a2, a));
          if (cr.dot(n) > 0) { mb.tri(a, b, b2, sidewalk, n, 0.85); mb.tri(a, b2, a2, sidewalk, n, 0.85); }
          else { mb.tri(a, b2, b, sidewalk, n, 0.85); mb.tri(a, a2, b2, sidewalk, n, 0.85); }
        }
      }
    }
  }
  // junction corner fills: a low square in sidewalk colour under each junction so corners are not bare ground
  for (const j of junctions.values()) {
    const walkEnds = j.ends.filter((e) => e.walk);
    if (walkEnds.length < 3) continue;
    let widest = walkEnds[0];
    for (const e of walkEnds) if (e.halfW > widest.halfW) widest = e;
    const r = widest.halfW + WALK_W;
    const ux = widest.dir.x, uz = -widest.dir.y, vx = -uz, vz = ux; // local frame: z = -north
    const y = j.pt.y + ROAD_Y - 0.06;
    const P = (u: number, v: number) => new THREE.Vector3(j.pt.x + ux * u + vx * v, y, j.pt.z + uz * u + vz * v);
    const a = P(-r, -r), b = P(r, -r), c2 = P(r, r), d = P(-r, r);
    const cr = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c2, a));
    if (cr.y >= 0) { mb.tri(a, b, c2, sidewalk, UP, 0.96); mb.tri(a, c2, d, sidewalk, UP, 0.96); }
    else { mb.tri(a, c2, b, sidewalk, UP, 0.96); mb.tri(a, d, c2, sidewalk, UP, 0.96); }
  }

  for (const f of feats) {
    const p = f.properties;
    if (p.tunnel) continue;
    const minor = MINOR.has(p.highway);
    const lift = p.bridge ? bridgeLift(p.layer) : 0;
    const deck = p.bridge || p.ramp ? parseDeck(p.deck) : null;
    for (const l of lines(f.geometry)) {
      let path = toPath(l, toLocal, groundAt, (minor ? ROAD_Y - 0.04 : ROAD_Y) + lift, SEG, deck);
      if (path.length < 2) continue;
      const carPath = path; // un-extended: endpoints sit on the OSM node so the traffic graph can join ways
      if (!minor) {
        const c = cleanRing(l);
        const [d0, d1] = endDirs(c);
        path = adjustEnds(path, otherHalfW(c[0], p.width / 2, d0), otherHalfW(c[c.length - 1], p.width / 2, d1));
      }
      ribbon(mb, path, p.width / 2, minor ? (TRAIL.has(p.highway) ? dirt : sidewalk) : asphalt, minor ? 0.94 : 1, deck ? undefined : draped((minor ? ROAD_Y - 0.04 : ROAD_Y) + lift));
      if (!minor) roadPaths.push({ path, width: p.width });
      if (!minor && p.highway !== 'service') {
        carPaths.push(carPath);
        carMeta.push({ oneway: !!p.oneway, width: p.width, highway: p.highway, lanes: p.lanes ?? (p.oneway ? 1 : 2), bridge: !!p.bridge, ramp: !!p.ramp, wayId: p.id });
      }
      if (minor && FOOT_MINOR.has(p.highway)) walkPaths.push(path);
      if ((p.bridge || p.ramp) && !minor && opts.bridges !== false) bridgeFurniture(mb, path, p.width / 2 + 2.2, (v) => groundAt(v.x + originX, -v.z + originY), concrete);
    }
  }

  // markings on top of the asphalt (after discs so junctions stay clean)
  for (const f of opts.markings === false ? [] : feats) {
    const p = f.properties;
    if (p.tunnel || MINOR.has(p.highway) || p.highway === 'service') continue;
    const lift = p.bridge ? bridgeLift(p.layer) : 0;
    const deck = p.bridge || p.ramp ? parseDeck(p.deck) : null;
    for (const l of lines(f.geometry)) {
      const path = toPath(l, toLocal, groundAt, ROAD_Y + 0.02 + lift, SEG, deck);
      if (path.length < 2) continue;
      const lanes = p.lanes ?? (p.oneway ? 1 : 2);
      if (!p.oneway && lanes >= 2) dashes(mb, path, 0.12, paint, 3, 6);
      if (lanes >= 3) {
        // lane dividers at +-laneW from the centre for 3-4 lanes
        const laneW = Math.min(3.5, p.width / lanes);
        for (const off of lanes >= 4 ? [laneW, -laneW] : [p.oneway ? 0 : laneW * 0.5]) {
          if (off === 0) continue;
          dashes(mb, offsetPath(path, off), 0.1, paint, 2, 4, 1);
        }
      }
    }
  }
  for (const f of rails) {
    const p = f.properties;
    const lift = p.bridge ? bridgeLift(p.layer) : 0;
    const deck = p.bridge || p.ramp ? parseDeck(p.deck) : null;
    for (const l of lines(f.geometry)) {
      const path = toPath(l, toLocal, groundAt, ROAD_Y + 0.02 + lift, SEG, deck);
      if ((p.bridge || p.ramp) && opts.bridges !== false) {
        // rail bridge: concrete deck under the track plus railings and piers
        ribbon(mb, path.map((v) => new THREE.Vector3(v.x, v.y - 0.3, v.z)), 3.2, concrete, 0.9);
        bridgeFurniture(mb, path, 3.2, (v) => groundAt(v.x + originX, -v.z + originY), concrete);
      }
      ribbon(mb, path, 1.6, railC, 0.95);
      ribbon(mb, path.map((v) => new THREE.Vector3(v.x, v.y + 0.02, v.z)), 0.75, hex('roof_dark'));
    }
  }
  // crosswalks: zebra bars parallel to the road, spanning its full width, at each crossing node
  for (const c of opts.markings === false ? [] : crossings) {
    const [x, y] = c.geometry.coordinates;
    const [lx, lz] = toLocal(x, y);
    const gy = groundAt(x, y) + ROAD_Y + 0.02;
    const near = nearestRoad(roadPaths, lx, lz);
    if (!near) continue;
    const dir = near.dir, side = new THREE.Vector3(-dir.z, 0, dir.x);
    const nBars = Math.max(3, Math.round(near.width / 1.0));
    for (let s = 0; s < nBars; s++) {
      const off = side.clone().multiplyScalar((s - (nBars - 1) / 2) * 1.0);
      const a = new THREE.Vector3(lx, gy, lz).add(off).addScaledVector(dir, -1.5);
      const b = new THREE.Vector3(lx, gy, lz).add(off).addScaledVector(dir, 1.5);
      ribbon(mb, [a, b], 0.28, paint);
    }
    // stop lines: a solid bar before the zebra on the approaching half (right-hand traffic) of each direction
    const hw = near.width / 2;
    for (const sgn of [1, -1]) {
      const centre = new THREE.Vector3(lx, gy, lz).addScaledVector(dir, -sgn * 2.4);
      const right = side.clone().multiplyScalar(sgn);
      ribbon(mb, [centre.clone().addScaledVector(right, 0.3), centre.clone().addScaledVector(right, hw - 0.2)], 0.25, paint);
    }
  }
  return { roads: mb.build(), paths: carPaths, pathMeta: carMeta, walkPaths };
}

function nearestRoad(paths: { path: THREE.Vector3[]; width: number }[], x: number, z: number): { dir: THREE.Vector3; width: number } | null {
  let best = 1e9, out: { dir: THREE.Vector3; width: number } | null = null;
  const q = new THREE.Vector3(x, 0, z);
  for (const { path, width } of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const ab = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
      const len2 = ab.lengthSq();
      if (len2 < 1e-9) continue;
      const t = THREE.MathUtils.clamp(new THREE.Vector3(x - a.x, 0, z - a.z).dot(ab) / len2, 0, 1);
      const d = q.distanceTo(new THREE.Vector3(a.x + ab.x * t, 0, a.z + ab.z * t));
      if (d < best) { best = d; out = { dir: ab.normalize(), width }; }
    }
  }
  return best < 12 ? out : null;
}
