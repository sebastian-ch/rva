import * as THREE from 'three';

/**
 * World-space size (in scene units) for a label pill that is `pixelWidth`x`pixelHeight`
 * screen pixels, given the current viewport height and orthographic camera zoom.
 *
 * The ortho camera shows 800 world units across the viewport height at zoom 1, so
 * world-per-pixel = 800 / (viewportHeight * zoom).
 */
export function labelScale(pixelWidth: number, pixelHeight: number, viewportHeight: number, zoom: number): [number, number] {
  const worldPerPixel = 800 / (viewportHeight * zoom);
  return [pixelWidth * worldPerPixel, pixelHeight * worldPerPixel];
}

const FONT = '600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const DAY_BG = '#eee3cc'; // cream
const DAY_FG = '#4a4038'; // shadow
const NIGHT_BG = '#22293a'; // night_fog
const NIGHT_FG = '#eee3cc'; // cream
const SUPERSAMPLE = 2;
const PAD_X = 14;
const PAD_Y = 8;
const LINE_HEIGHT = 16;

interface BuiltTexture {
  texture: THREE.CanvasTexture;
  pixelWidth: number;
  pixelHeight: number;
}

/** Draws a rounded pill label to a canvas texture. Returns null outside a DOM (tests, SSR). */
function drawLabelTexture(name: string, night: boolean): BuiltTexture | null {
  if (typeof document === 'undefined') return null;
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  measure.font = FONT;
  const textWidth = measure.measureText(name).width;
  const pixelWidth = Math.max(1, Math.ceil(textWidth + PAD_X * 2));
  const pixelHeight = Math.max(1, Math.ceil(LINE_HEIGHT + PAD_Y * 2));

  const canvas = document.createElement('canvas');
  canvas.width = pixelWidth * SUPERSAMPLE;
  canvas.height = pixelHeight * SUPERSAMPLE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const r = pixelHeight / 2;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(pixelWidth - r, 0);
  ctx.arcTo(pixelWidth, 0, pixelWidth, r, r);
  ctx.lineTo(pixelWidth, pixelHeight - r);
  ctx.arcTo(pixelWidth, pixelHeight, pixelWidth - r, pixelHeight, r);
  ctx.lineTo(r, pixelHeight);
  ctx.arcTo(0, pixelHeight, 0, pixelHeight - r, r);
  ctx.lineTo(0, r);
  ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  ctx.fillStyle = night ? NIGHT_BG : DAY_BG;
  ctx.fill();

  ctx.fillStyle = night ? NIGHT_FG : DAY_FG;
  ctx.fillText(name, pixelWidth / 2, pixelHeight / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return { texture, pixelWidth, pixelHeight };
}

interface Entry {
  sprite: THREE.Sprite;
  name: string;
  pixelWidth: number;
  pixelHeight: number;
  textures: Map<boolean, THREE.CanvasTexture>;
}

/** Manages floating name-pill sprites above landmark buildings. */
export class LandmarkLabels {
  readonly group = new THREE.Group();
  private entries = new Map<string, Entry>();
  private night = false;

  set(slug: string, name: string, position: THREE.Vector3): void {
    let entry = this.entries.get(slug);
    if (!entry) {
      const material = new THREE.SpriteMaterial({ transparent: true, depthTest: false });
      const sprite = new THREE.Sprite(material);
      sprite.center.set(0.5, 0);
      sprite.renderOrder = 10;
      this.group.add(sprite);
      entry = { sprite, name, pixelWidth: 0, pixelHeight: 0, textures: new Map() };
      this.entries.set(slug, entry);
    }
    entry.name = name;
    entry.sprite.position.copy(position).add(new THREE.Vector3(0, 14, 0));
    this.applyTexture(entry);
  }

  remove(slug: string): void {
    const entry = this.entries.get(slug);
    if (!entry) return;
    this.group.remove(entry.sprite);
    entry.sprite.material.dispose();
    for (const tex of entry.textures.values()) tex.dispose();
    this.entries.delete(slug);
  }

  update(zoom: number, night: boolean): void {
    if (night !== this.night) {
      this.night = night;
      for (const entry of this.entries.values()) this.applyTexture(entry);
    }
    this.group.visible = zoom >= 2;
    if (!this.group.visible) return;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;
    for (const entry of this.entries.values()) {
      const [w, h] = labelScale(entry.pixelWidth, entry.pixelHeight, viewportHeight, zoom);
      entry.sprite.scale.set(w, h, 1);
    }
  }

  private applyTexture(entry: Entry): void {
    let texture = entry.textures.get(this.night);
    if (!texture) {
      const built = drawLabelTexture(entry.name, this.night);
      if (!built) return; // no DOM (e.g. tests) — leave sprite untextured
      texture = built.texture;
      entry.pixelWidth = built.pixelWidth;
      entry.pixelHeight = built.pixelHeight;
      entry.textures.set(this.night, texture);
    }
    entry.sprite.material.map = texture;
    entry.sprite.material.needsUpdate = true;
  }
}
