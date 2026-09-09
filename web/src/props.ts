import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import palette from '../../assets/palette.json';

export type PropKind = 'tree' | 'tree_round' | 'streetlight' | 'car' | 'bench' | 'person';

export const PROP_KINDS: PropKind[] = ['tree', 'tree_round', 'streetlight', 'car', 'bench', 'person'];

export function hex(key: keyof typeof palette): THREE.Color {
  return new THREE.Color(palette[key]);
}

export function applyVertexColor(geom: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const count = geom.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geom;
}

export interface ColoredPart {
  geom: THREE.BufferGeometry;
  color: THREE.Color;
  position?: [number, number, number];
  scale?: [number, number, number];
}

export function mergeColored(parts: ColoredPart[]): THREE.BufferGeometry {
  const prepared: THREE.BufferGeometry[] = parts.map((part) => {
    let g = part.geom.toNonIndexed();
    // Drop non-position/normal attributes (e.g. uv) for a consistent attribute set.
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal') {
        g.deleteAttribute(name);
      }
    }
    if (part.scale) {
      g = g.clone();
      g.scale(part.scale[0], part.scale[1], part.scale[2]);
    }
    if (part.position) {
      g.translate(part.position[0], part.position[1], part.position[2]);
    }
    applyVertexColor(g, part.color);
    return g;
  });

  const merged = mergeGeometries(prepared, false);
  if (!merged) {
    throw new Error('mergeColored: mergeGeometries failed');
  }
  merged.computeVertexNormals();
  return merged;
}

function buildTree(round: boolean): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.15, 0.15, 1.2, 6);
  const canopy = round
    ? new THREE.IcosahedronGeometry(1.6, 0)
    : new THREE.ConeGeometry(1.4, 3.2, 6);

  const canopyY = round ? 1.2 + 1.6 : 1.2 + 3.2 / 2;

  return mergeColored([
    { geom: trunk, color: hex('trunk'), position: [0, 0.6, 0] },
    { geom: canopy, color: hex('canopy'), position: [0, canopyY, 0] },
  ]);
}

function buildStreetlight(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.06, 0.06, 5, 6);
  const lamp = new THREE.BoxGeometry(0.25, 0.2, 0.25);

  return mergeColored([
    { geom: pole, color: hex('steel'), position: [0, 2.5, 0] },
    { geom: lamp, color: hex('window_lit'), position: [0.6, 4.9, 0] },
  ]);
}

function buildCar(bodyColorKey: keyof typeof palette = 'brick'): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(4.2, 1.4, 1.7);
  const cabin = new THREE.BoxGeometry(2.2, 0.8, 1.4);
  const wheel = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 8);
  wheel.rotateX(Math.PI / 2);

  const wheelY = 0.35;
  const wheelXOff = 1.4;
  const wheelZOff = 0.85;

  return mergeColored([
    { geom: body, color: hex(bodyColorKey), position: [0, 0.7 + 0.35, 0] },
    { geom: cabin, color: hex(bodyColorKey), position: [0, 1.4 + 0.35 + 0.4, 0] },
    { geom: wheel.clone(), color: hex('roof_dark'), position: [wheelXOff, wheelY, wheelZOff] },
    { geom: wheel.clone(), color: hex('roof_dark'), position: [-wheelXOff, wheelY, wheelZOff] },
    { geom: wheel.clone(), color: hex('roof_dark'), position: [wheelXOff, wheelY, -wheelZOff] },
    { geom: wheel.clone(), color: hex('roof_dark'), position: [-wheelXOff, wheelY, -wheelZOff] },
  ]);
}

function buildBench(): THREE.BufferGeometry {
  const plank = new THREE.BoxGeometry(1.6, 0.06, 0.35);
  const leg = new THREE.BoxGeometry(0.06, 0.45, 0.35);

  return mergeColored([
    { geom: plank.clone(), color: hex('trunk'), position: [0, 0.45, 0] },
    { geom: plank.clone(), color: hex('trunk'), position: [0, 0.9, -0.12] },
    { geom: leg.clone(), color: hex('steel'), position: [0.7, 0.225, 0] },
    { geom: leg.clone(), color: hex('steel'), position: [-0.7, 0.225, 0] },
  ]);
}

function buildPerson(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.2, 0.25, 0.9, 8);
  const head = new THREE.SphereGeometry(0.2, 8, 6);

  return mergeColored([
    { geom: body, color: hex('slate'), position: [0, 0.45, 0] },
    { geom: head, color: hex('sand'), position: [0, 0.9 + 0.2, 0] },
  ]);
}

export function buildPropGeometry(kind: PropKind, color?: keyof typeof palette): THREE.BufferGeometry {
  let geom: THREE.BufferGeometry;
  switch (kind) {
    case 'tree':
      geom = buildTree(false);
      break;
    case 'tree_round':
      geom = buildTree(true);
      break;
    case 'streetlight':
      geom = buildStreetlight();
      break;
    case 'car':
      geom = buildCar(color ?? 'brick');
      break;
    case 'bench':
      geom = buildBench();
      break;
    case 'person':
      geom = buildPerson();
      break;
  }
  geom.computeVertexNormals();
  return geom;
}

export function propStats(): Record<PropKind, number> {
  const stats = {} as Record<PropKind, number>;
  for (const kind of PROP_KINDS) {
    stats[kind] = buildPropGeometry(kind).attributes.position.count;
  }
  return stats;
}
