import * as THREE from 'three';
import type { LoadedTile } from './tiles';
import type { IsoCamera } from './camera';
import type { TileManager } from './tileManager';

/**
 * Console helpers exposed on window.__iso for refining the model:
 *   __iso.where()            -> camera target in local metres (x east, z = -north), zoom, and the tile id
 *   __iso.find('Capitol')    -> buildings whose name/addr match, with local coords
 *   __iso.goto(x, z, zoom?)  -> move the camera (also accepts a building id or landmark slug)
 *   __iso.building(id)       -> properties of a loaded building
 *   __iso.counts()           -> resident tiles, triangles, props
 */
export interface DebugDeps {
  iso: IsoCamera;
  tiles: LoadedTile[];
  manager: () => TileManager | null;
  landmarkTargets: Map<string, THREE.Vector3>;
  propCounts: () => Record<string, number>;
  /** traffic worker stats plus how many vehicles the pool is drawing */
  traffic?: () => Record<string, number | string>;
}

export function createDebug(d: DebugDeps) {
  const tileSize = () => d.manager()?.index.tile_size ?? 250;
  const tileIdAt = (x: number, z: number) => `${Math.floor(x / tileSize())}_${Math.floor(-z / tileSize())}`;

  const where = () => {
    const t = d.iso.controls.target;
    const out = { x: Math.round(t.x), z: Math.round(t.z), y: +t.y.toFixed(1), zoom: +d.iso.camera.zoom.toFixed(2), tile: tileIdAt(t.x, t.z), snap: `--at ${Math.round(t.x)},${Math.round(t.z)} --zoom ${d.iso.camera.zoom.toFixed(1)}` };
    console.table(out);
    return out;
  };

  const find = (text: string) => {
    const q = text.toLowerCase();
    const rows: { id: string; name: string | null; addr: string | null; height: number; source: string; x: number; z: number; tile: string }[] = [];
    for (const t of d.tiles) {
      for (const r of t.ranges) {
        const p = r.props;
        if (!(p.name ?? '').toLowerCase().includes(q) && !(p.addr ?? '').toLowerCase().includes(q) && p.id !== text && p.landmark !== text) continue;
        const c = centerOf(t, r.start, r.count);
        rows.push({ id: p.id, name: p.name, addr: p.addr, height: p.height, source: p.height_source, x: Math.round(c.x), z: Math.round(c.z), tile: t.meta.id });
      }
    }
    console.table(rows);
    return rows;
  };

  const goto = (x: number | string, z?: number, zoom?: number) => {
    let target: THREE.Vector3 | null = null;
    if (typeof x === 'string') {
      const lm = d.landmarkTargets.get(x);
      if (lm) target = lm.clone();
      else { const r = find(x)[0]; if (r) target = new THREE.Vector3(r.x, 0, r.z); }
      if (!target) { console.warn('not found', x); return; }
    } else target = new THREE.Vector3(x, 0, z ?? 0);
    const delta = target.clone().sub(d.iso.controls.target);
    delta.y = 0;
    d.iso.controls.target.add(delta);
    d.iso.camera.position.add(delta);
    if (zoom) { d.iso.camera.zoom = zoom; d.iso.camera.updateProjectionMatrix(); }
    d.iso.controls.update();
    d.manager()?.update(d.iso.camera, d.iso.camera.zoom, true);
    return where();
  };

  const building = (id: string) => {
    for (const t of d.tiles) { const r = t.ranges.find((r) => r.props.id === id); if (r) return r.props; }
    return null;
  };

  const counts = () => ({ ...(d.manager()?.summary() ?? {}), props: d.propCounts(), traffic: d.traffic?.() ?? null });

  return { where, find, goto, building, counts };
}

function centerOf(t: LoadedTile, start: number, count: number): THREE.Vector3 {
  const pos = t.buildings?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const box = new THREE.Box3();
  if (pos) { const v = new THREE.Vector3(); for (let i = start * 3; i < (start + count) * 3; i++) box.expandByPoint(v.fromBufferAttribute(pos, i)); }
  return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
}
