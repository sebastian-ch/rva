import * as THREE from 'three';
import { hex } from './props';

/**
 * Elevation visualisation shared by every ground/building material:
 *  - always: faint contour lines on the terrain every `contour` metres (world y), anti-aliased with fwidth
 *  - heights mode (uHeights = 1): hypsometric tint by world y over [uMinY, uMaxY] on everything, windows off
 * Chains with a material's existing onBeforeCompile (facade, water).
 */
export interface HeightsOptions { contours?: boolean; contour?: number }

export const HEIGHT_STOPS: { t: number; color: string }[] = [
  { t: 0.0, color: '#4f86a8' }, { t: 0.18, color: '#7fb3a0' }, { t: 0.4, color: '#a9c27a' },
  { t: 0.62, color: '#e0c477' }, { t: 0.82, color: '#d38a5c' }, { t: 1.0, color: '#f2e9d8' },
];

const shared = {
  uHeights: { value: 0 },
  uMinY: { value: 0 },
  uMaxY: { value: 160 },
  uContour: { value: 5 },
  uContourColor: { value: hex('shadow') },
};

const GLSL_VARY = /* glsl */ `varying vec3 vIsoWorld;`;
const GLSL_FRAG_HEAD = /* glsl */ `
uniform float uHeights; uniform float uMinY; uniform float uMaxY; uniform float uContour; uniform vec3 uContourColor;
vec3 isoRamp(float t) {
  vec3 c0 = vec3(0.310, 0.525, 0.659); vec3 c1 = vec3(0.498, 0.702, 0.627); vec3 c2 = vec3(0.663, 0.761, 0.478);
  vec3 c3 = vec3(0.878, 0.769, 0.467); vec3 c4 = vec3(0.827, 0.541, 0.361); vec3 c5 = vec3(0.949, 0.914, 0.847);
  if (t < 0.18) return mix(c0, c1, t / 0.18);
  if (t < 0.40) return mix(c1, c2, (t - 0.18) / 0.22);
  if (t < 0.62) return mix(c2, c3, (t - 0.40) / 0.22);
  if (t < 0.82) return mix(c3, c4, (t - 0.62) / 0.20);
  return mix(c4, c5, (t - 0.82) / 0.18);
}
`;

function contourGLSL(strength: number): string {
  return /* glsl */ `
  {
    float h = vIsoWorld.y / uContour;
    float fw = fwidth(h) * 1.2 + 1e-4;
    float line = 1.0 - smoothstep(0.0, fw * 1.5, abs(fract(h + 0.5) - 0.5));
    // fade contours out when they get denser than ~3 px apart
    line *= 1.0 - smoothstep(0.25, 0.5, fw);
    float major = step(0.5, 1.0 - smoothstep(0.0, fw * 1.5, abs(fract(h / 5.0 + 0.5) - 0.5)));
    float k = line * (${strength.toFixed(2)} + 0.25 * major) * (1.0 + uHeights);
    diffuseColor.rgb = mix(diffuseColor.rgb, uContourColor, clamp(k, 0.0, 0.6));
  }`;
}

const GLSL_TINT = /* glsl */ `
  if (uHeights > 0.5) {
    float t = clamp((vIsoWorld.y - uMinY) / max(uMaxY - uMinY, 1.0), 0.0, 1.0);
    float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = isoRamp(t) * (0.75 + 0.5 * lum);
  }`;

export function applyHeightsMode(material: THREE.Material, opts: HeightsOptions = {}): void {
  const prev = material.onBeforeCompile;
  const contours = opts.contours ?? false;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    Object.assign(shader.uniforms, shared);
    // the world-position varying may already come from another injection (ground detail); declare it once
    if (!shader.vertexShader.includes('vIsoWorld')) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${GLSL_VARY}`)
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvIsoWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    }
    const fragVary = shader.fragmentShader.includes('vIsoWorld') ? '' : GLSL_VARY;
    // insert after colour + any earlier injection (facade windows / water) so the tint overrides them
    const marker = '#include <alphamap_fragment>';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragVary}\n${GLSL_FRAG_HEAD}`)
      .replace(marker, `${marker}\n${contours ? contourGLSL(0.22) : ''}\n${GLSL_TINT}`);
  };
  const key = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${key ? key.call(material) : ''}|iso-heights-${contours ? 'c' : 'n'}`;
  material.needsUpdate = true;
}

export function setHeightsMode(on: boolean) { shared.uHeights.value = on ? 1 : 0; }
export function setHeightsRange(minY: number, maxY: number, contour = 5) {
  shared.uMinY.value = minY; shared.uMaxY.value = maxY; shared.uContour.value = contour;
}
export function heightsRange(): { min: number; max: number; contour: number } {
  return { min: shared.uMinY.value, max: shared.uMaxY.value, contour: shared.uContour.value };
}
