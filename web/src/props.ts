import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import palette from '../../assets/palette.json';

export type PropKind =
  | 'tree'
  | 'tree_round'
  | 'streetlight'
  | 'car'
  | 'suv'
  | 'pickup'
  | 'van'
  | 'bench'
  | 'person'
  | 'traffic_light'
  | 'bus'
  | 'fountain';

export const PROP_KINDS: PropKind[] = [
  'tree',
  'tree_round',
  'streetlight',
  'car',
  'suv',
  'pickup',
  'van',
  'bench',
  'person',
  'traffic_light',
  'bus',
  'fountain',
];

/** Low-poly vehicle body kinds built by buildCar/buildSuv/buildPickup/buildVan. */
export const VEHICLE_KINDS: PropKind[] = ['car', 'suv', 'pickup', 'van'];

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

/**
 * A box whose top face is tilted: the -X ("rear") edge sits at height h0 and the
 * +X ("front") edge sits at height h1, both measured from the wedge's own base
 * (y=0). Used for hoods/trunks/glass slopes (+X is vehicle-forward). All four
 * side faces and the bottom stay flat/rectangular; only the top is sloped.
 */
function wedge(length: number, width: number, h0: number, h1: number): THREE.BufferGeometry {
  const hx = length / 2;
  const hz = width / 2;
  const A0: [number, number, number] = [-hx, 0, -hz];
  const A1: [number, number, number] = [hx, 0, -hz];
  const A2: [number, number, number] = [hx, 0, hz];
  const A3: [number, number, number] = [-hx, 0, hz];
  const B0: [number, number, number] = [-hx, h0, -hz];
  const B1: [number, number, number] = [hx, h1, -hz];
  const B2: [number, number, number] = [hx, h1, hz];
  const B3: [number, number, number] = [-hx, h0, hz];

  const tris: [number, number, number][] = [
    A0, A1, A2, A0, A2, A3, // bottom (-Y)
    B0, B2, B1, B0, B3, B2, // top (sloped, +Y-ish)
    A0, A3, B3, A0, B3, B0, // rear (-X)
    A1, B2, A2, A1, B1, B2, // front (+X)
    A0, B1, A1, A0, B0, B1, // -Z side
    A3, A2, B2, A3, B2, B3, // +Z side
  ];

  const positions = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    positions[i * 3] = tris[i][0];
    positions[i * 3 + 1] = tris[i][1];
    positions[i * 3 + 2] = tris[i][2];
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

const WHITE = new THREE.Color(1, 1, 1);
const VEHICLE_GLASS = hex('slate').clone().multiplyScalar(0.6);

function vehicleWheel(radius: number, width: number): THREE.BufferGeometry {
  const wheel = new THREE.CylinderGeometry(radius, radius, width, 6);
  wheel.rotateX(Math.PI / 2);
  return wheel;
}

function lightBox(width: number, height: number, depth: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(width, height, depth);
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

// Note: bodyWhite defaults to true (via `?? true` at the call site in
// buildPropGeometry) for the vehicle kinds, so an InstancedMesh per-instance
// color (setColorAt) multiplies cleanly into the final palette color instead
// of tinting an already-colored vertex. Pass bodyWhite=false explicitly (with
// a palette color key) to bake a fixed body color instead.
function buildCar(bodyColorKey: keyof typeof palette = 'brick', bodyWhite = true): THREE.BufferGeometry {
  const bodyColor = bodyWhite ? WHITE : hex(bodyColorKey);

  const len = 4.5;
  const wid = 1.8;
  const front = len / 2;
  const rear = -len / 2;
  const bodyH = 0.85;
  const hoodLen = 1.3;
  const hoodBackX = front - hoodLen; // 0.95

  const mainLen = hoodBackX - rear; // 3.2
  const mainBody: ColoredPart = {
    geom: new THREE.BoxGeometry(mainLen, bodyH, wid),
    color: bodyColor,
    position: [rear + mainLen / 2, bodyH / 2, 0],
  };
  const hood: ColoredPart = {
    geom: wedge(hoodLen, wid, bodyH, 0.75),
    color: bodyColor,
    position: [hoodBackX + hoodLen / 2, 0, 0],
  };

  // Cabin: windshield (glass wedge) -> mid box (roof+sides, white) -> rear glass wedge.
  const cabinLen = 2.0;
  const cabinWid = 1.6;
  const cabinBase = bodyH; // 0.85
  const cabinTop = 1.42;
  const cabinH = cabinTop - cabinBase; // 0.57
  const glassLen = 0.5;
  const midLen = cabinLen - 2 * glassLen; // 1.0
  const cabinFront = hoodBackX; // cabin sits right behind the hood
  const midFront = cabinFront - glassLen;
  const midRear = midFront - midLen;

  const windshield: ColoredPart = {
    // rear (-X) edge at full cabin height, front (+X) edge tapers to 0 at the hood line.
    geom: wedge(glassLen, cabinWid, cabinH, 0),
    color: VEHICLE_GLASS,
    position: [midFront + glassLen / 2, cabinBase, 0],
  };
  const rearGlass: ColoredPart = {
    // rear (-X) edge tapers to 0 at the body line, front (+X) edge at full cabin height.
    geom: wedge(glassLen, cabinWid, 0, cabinH),
    color: VEHICLE_GLASS,
    position: [midRear - glassLen / 2, cabinBase, 0],
  };
  const cabinMid: ColoredPart = {
    geom: new THREE.BoxGeometry(midLen, cabinH, cabinWid),
    color: bodyColor,
    position: [midRear + midLen / 2, cabinBase + cabinH / 2, 0],
  };

  const wheelR = 0.34;
  const wheelW = 0.25;
  const wheel = vehicleWheel(wheelR, wheelW);
  const wheelXOff = 1.45;
  const wheelZOff = 0.8;
  const wheels = wheelPositions(wheelXOff, wheelZOff).map(
    (p): ColoredPart => ({ geom: wheel.clone(), color: hex('roof_dark'), position: [p[0], wheelR, p[1]] }),
  );

  const headlight: ColoredPart = {
    geom: lightBox(0.06, 0.16, wid * 0.6),
    color: hex('window_lit'),
    position: [front - 0.03, 0.45, 0],
  };
  const taillight: ColoredPart = {
    geom: lightBox(0.06, 0.16, wid * 0.6),
    color: hex('brick'),
    position: [rear + 0.03, 0.45, 0],
  };

  return mergeColored([mainBody, hood, windshield, rearGlass, cabinMid, ...wheels, headlight, taillight]);
}

function wheelPositions(xOff: number, zOff: number): [number, number][] {
  return [
    [xOff, zOff],
    [-xOff, zOff],
    [xOff, -zOff],
    [-xOff, -zOff],
  ];
}

function buildSuv(bodyWhite = true, bodyColorKey: keyof typeof palette = 'brick'): THREE.BufferGeometry {
  const bodyColor = bodyWhite ? WHITE : hex(bodyColorKey);

  const len = 4.7;
  const wid = 1.9;
  const bodyH = 1.0;

  const body: ColoredPart = {
    geom: new THREE.BoxGeometry(len, bodyH, wid),
    color: bodyColor,
    position: [0, bodyH / 2, 0],
  };

  const cabinLen = 2.6;
  const cabinWid = 1.75;
  const cabinBase = bodyH;
  const cabinTop = 1.75;
  const glassH = 0.55;
  const roofH = cabinTop - cabinBase - glassH; // 0.2

  const glassBand: ColoredPart = {
    geom: new THREE.BoxGeometry(cabinLen, glassH, cabinWid),
    color: VEHICLE_GLASS,
    position: [0, cabinBase + glassH / 2, 0],
  };
  const roofCap: ColoredPart = {
    geom: new THREE.BoxGeometry(cabinLen, roofH, cabinWid),
    color: bodyColor,
    position: [0, cabinBase + glassH + roofH / 2, 0],
  };

  const wheelR = 0.4;
  const wheelW = 0.28;
  const wheel = vehicleWheel(wheelR, wheelW);
  const wheels = wheelPositions(len / 2 - 1.0, wid / 2 - wheelW / 2 - 0.02).map(
    (p): ColoredPart => ({ geom: wheel.clone(), color: hex('roof_dark'), position: [p[0], wheelR, p[1]] }),
  );

  const headlight: ColoredPart = {
    geom: lightBox(0.06, 0.18, wid * 0.6),
    color: hex('window_lit'),
    position: [len / 2 - 0.03, 0.5, 0],
  };
  const taillight: ColoredPart = {
    geom: lightBox(0.06, 0.18, wid * 0.6),
    color: hex('brick'),
    position: [-len / 2 + 0.03, 0.5, 0],
  };

  return mergeColored([body, glassBand, roofCap, ...wheels, headlight, taillight]);
}

function buildPickup(bodyWhite = true, bodyColorKey: keyof typeof palette = 'brick'): THREE.BufferGeometry {
  const bodyColor = bodyWhite ? WHITE : hex(bodyColorKey);

  const len = 5.3;
  const wid = 1.9;
  const front = len / 2;
  const rear = -len / 2;
  const deckH = 0.4; // shared chassis / open-bed floor + wall height

  const chassis: ColoredPart = {
    geom: new THREE.BoxGeometry(len, deckH, wid),
    color: bodyColor,
    position: [0, deckH / 2, 0],
  };

  // Short hood ahead of the cab, sloping down toward the nose.
  const cabFront = 1.4;
  const hoodLen = front - cabFront; // 1.25
  const hood: ColoredPart = {
    geom: wedge(hoodLen, wid, 0.2, 0.05),
    color: bodyColor,
    position: [cabFront + hoodLen / 2, deckH, 0],
  };

  const cabRear = -0.2;
  const cabLen = cabFront - cabRear; // 1.6
  const cabWid = 1.7;
  const cabTop = 1.7;
  const pillarH = 0.15;
  const glassH = 0.6;
  const roofH = cabTop - deckH - pillarH - glassH; // 0.55

  const pillars: ColoredPart = {
    geom: new THREE.BoxGeometry(cabLen, pillarH, cabWid),
    color: bodyColor,
    position: [cabRear + cabLen / 2, deckH + pillarH / 2, 0],
  };
  const glassBand: ColoredPart = {
    geom: new THREE.BoxGeometry(cabLen, glassH, cabWid),
    color: VEHICLE_GLASS,
    position: [cabRear + cabLen / 2, deckH + pillarH + glassH / 2, 0],
  };
  const roofCap: ColoredPart = {
    geom: new THREE.BoxGeometry(cabLen, roofH, cabWid),
    color: bodyColor,
    position: [cabRear + cabLen / 2, deckH + pillarH + glassH + roofH / 2, 0],
  };

  const wheelR = 0.4;
  const wheelW = 0.28;
  const wheel = vehicleWheel(wheelR, wheelW);
  const wheels = wheelPositions(len / 2 - 1.05, wid / 2 - wheelW / 2 - 0.02).map(
    (p): ColoredPart => ({ geom: wheel.clone(), color: hex('roof_dark'), position: [p[0], wheelR, p[1]] }),
  );

  const headlight: ColoredPart = {
    geom: lightBox(0.06, 0.18, wid * 0.6),
    color: hex('window_lit'),
    position: [front - 0.03, 0.5, 0],
  };
  const taillight: ColoredPart = {
    geom: lightBox(0.06, 0.18, wid * 0.6),
    color: hex('brick'),
    position: [rear + 0.03, 0.5, 0],
  };

  return mergeColored([chassis, hood, pillars, glassBand, roofCap, ...wheels, headlight, taillight]);
}

function buildVan(bodyWhite = true, bodyColorKey: keyof typeof palette = 'brick'): THREE.BufferGeometry {
  const bodyColor = bodyWhite ? WHITE : hex(bodyColorKey);

  const len = 5.0;
  const wid = 2.0;
  const front = len / 2;
  const rear = -len / 2;
  const hoodLen = 0.8;
  const hoodBackX = front - hoodLen; // 1.7

  const mainLen = hoodBackX - rear; // 4.2
  const mainCenterX = rear + mainLen / 2; // -0.4
  const bodyTop = 2.1;
  const lowerH = 0.9;
  const glassH = 0.8;
  const upperH = bodyTop - lowerH - glassH; // 0.4

  const lower: ColoredPart = {
    geom: new THREE.BoxGeometry(mainLen, lowerH, wid),
    color: bodyColor,
    position: [mainCenterX, lowerH / 2, 0],
  };
  const glassBand: ColoredPart = {
    geom: new THREE.BoxGeometry(mainLen, glassH, wid),
    color: VEHICLE_GLASS,
    position: [mainCenterX, lowerH + glassH / 2, 0],
  };
  const upper: ColoredPart = {
    geom: new THREE.BoxGeometry(mainLen, upperH, wid),
    color: bodyColor,
    position: [mainCenterX, lowerH + glassH + upperH / 2, 0],
  };
  const hood: ColoredPart = {
    geom: wedge(hoodLen, wid, 1.0, 0.8),
    color: bodyColor,
    position: [hoodBackX + hoodLen / 2, 0, 0],
  };

  const wheelR = 0.36;
  const wheelW = 0.3;
  const wheel = vehicleWheel(wheelR, wheelW);
  const wheels = wheelPositions(len / 2 - 1.1, wid / 2 - wheelW / 2 - 0.02).map(
    (p): ColoredPart => ({ geom: wheel.clone(), color: hex('roof_dark'), position: [p[0], wheelR, p[1]] }),
  );

  const headlight: ColoredPart = {
    geom: lightBox(0.06, 0.18, wid * 0.6),
    color: hex('window_lit'),
    position: [front - 0.03, 0.55, 0],
  };
  const taillight: ColoredPart = {
    geom: lightBox(0.06, 0.18, wid * 0.6),
    color: hex('brick'),
    position: [rear + 0.03, 0.55, 0],
  };

  return mergeColored([lower, glassBand, upper, hood, ...wheels, headlight, taillight]);
}

function buildTrafficLight(): THREE.BufferGeometry {
  // Square pole (a box, not a cylinder) and flat lens faces keep this well under the
  // 200-vertex budget while still reading as a traffic signal at isometric scale.
  const pole = new THREE.BoxGeometry(0.14, 4.5, 0.14);
  const arm = new THREE.BoxGeometry(3, 0.08, 0.08);
  const head = new THREE.BoxGeometry(0.3, 0.9, 0.3);
  const lens = new THREE.PlaneGeometry(0.16, 0.16);

  const armXOff = 1.5; // arm runs from the pole (x=0) out to x=3
  const headX = 3;
  const headY = 4.5 - 0.55;

  return mergeColored([
    { geom: pole, color: hex('steel'), position: [0, 2.25, 0] },
    { geom: arm, color: hex('steel'), position: [armXOff, 4.5, 0] },
    { geom: head, color: hex('roof_dark'), position: [headX, headY, 0] },
    { geom: lens, color: hex('brick'), position: [headX, headY + 0.28, 0.18] },
    { geom: lens.clone(), color: hex('sand'), position: [headX, headY, 0.18] },
    { geom: lens.clone(), color: hex('roof_green'), position: [headX, headY - 0.28, 0.18] },
  ]);
}

function buildBus(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(11, 2.5, 3);
  const roofBand = new THREE.BoxGeometry(11, 0.4, 3.05);
  const wheel = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 6);
  wheel.rotateX(Math.PI / 2);

  const wheelY = 0.5;
  const wheelZOff = 1.55;
  const wheelXOffs = [-4, 0, 4];

  const parts: ColoredPart[] = [
    { geom: body, color: hex('sand'), position: [0, 0.5 + 1.25, 0] },
    { geom: roofBand, color: hex('roof_dark'), position: [0, 0.5 + 2.5 - 0.2, 0] },
  ];
  for (const x of wheelXOffs) {
    parts.push({ geom: wheel.clone(), color: hex('roof_dark'), position: [x, wheelY, wheelZOff] });
    parts.push({ geom: wheel.clone(), color: hex('roof_dark'), position: [x, wheelY, -wheelZOff] });
  }
  return mergeColored(parts);
}

function buildFountain(): THREE.BufferGeometry {
  const basin = new THREE.CylinderGeometry(3, 3, 0.5, 12);
  const waterDisc = new THREE.CylinderGeometry(2.7, 2.7, 0.05, 12);
  const column = new THREE.CylinderGeometry(0.2, 0.25, 1, 8);

  return mergeColored([
    { geom: basin, color: hex('concrete'), position: [0, 0.25, 0] },
    { geom: waterDisc, color: hex('water'), position: [0, 0.5 + 0.025, 0] },
    { geom: column, color: hex('concrete'), position: [0, 0.5 + 0.5, 0] },
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

export function buildPropGeometry(
  kind: PropKind,
  color?: keyof typeof palette,
  bodyWhite?: boolean,
): THREE.BufferGeometry {
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
      // Vehicle kinds default bodyWhite to true (unless explicitly overridden)
      // so an InstancedMesh per-instance color multiplies cleanly.
      geom = buildCar(color ?? 'brick', bodyWhite ?? true);
      break;
    case 'suv':
      geom = buildSuv(bodyWhite ?? true, color ?? 'brick');
      break;
    case 'pickup':
      geom = buildPickup(bodyWhite ?? true, color ?? 'brick');
      break;
    case 'van':
      geom = buildVan(bodyWhite ?? true, color ?? 'brick');
      break;
    case 'bench':
      geom = buildBench();
      break;
    case 'person':
      geom = buildPerson();
      break;
    case 'traffic_light':
      geom = buildTrafficLight();
      break;
    case 'bus':
      geom = buildBus();
      break;
    case 'fountain':
      geom = buildFountain();
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
