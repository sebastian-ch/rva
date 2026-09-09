import * as THREE from 'three';
import palette from '../../assets/palette.json';
import { hex } from './props';
import type { BuildingProps } from './types';
import { regionId } from './region';

/** Facade style ids consumed by the shader. */
export const STYLE_NONE = 0, STYLE_RESIDENTIAL = 1, STYLE_OFFICE = 2, STYLE_RETAIL = 3, STYLE_INDUSTRIAL = 4;

const RETAIL = new Set(['retail', 'commercial', 'supermarket', 'kiosk', 'hotel']);
const OFFICE = new Set(['office', 'government', 'public', 'hospital', 'university', 'civic']);
const RESIDENTIAL = new Set(['house', 'residential', 'apartments', 'terrace', 'detached', 'semidetached_house', 'dormitory']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'garage', 'garages', 'shed', 'roof', 'parking', 'service', 'hangar']);

export interface FacadeParams { floor: number; style: number }

/** Floor height (m) and style for a building. Style 0 means no windows. */
export function facadeParams(p: BuildingProps): FacadeParams {
  const t = p.type;
  if (p.height < 3.5 || INDUSTRIAL.has(t) && p.height < 5) return { floor: 0, style: STYLE_NONE };
  let style: number;
  if (RETAIL.has(t)) style = STYLE_RETAIL;
  else if (OFFICE.has(t) || p.height > 30) style = STYLE_OFFICE;
  else if (INDUSTRIAL.has(t)) style = STYLE_INDUSTRIAL;
  else if (RESIDENTIAL.has(t)) style = STYLE_RESIDENTIAL;
  else style = p.height > 15 ? STYLE_OFFICE : p.height > 8 ? STYLE_RETAIL : STYLE_RESIDENTIAL;
  // floor height: prefer OSM levels when they agree with the height
  let floor = style === STYLE_OFFICE ? 3.6 : 3.2;
  if (p.levels && p.levels > 0) {
    const f = p.height / p.levels;
    if (f > 2.4 && f < 5.5) floor = f;
  }
  return { floor, style };
}

const GLSL_COMMON = /* glsl */ `
varying vec2 vFacadeUv;
varying vec4 vFacade;
`;

const GLSL_FRAG = /* glsl */ `
uniform float uNight;
uniform vec3 uWindowLit;
uniform vec3 uGlass;
uniform float uWeathering;
float fhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

// Runs after color_fragment: diffuseColor holds the vertex colour. Adds windows, sills, cornice, storefront.
const GLSL_WINDOWS = /* glsl */ `
#include <color_fragment>
{
  float floorH = vFacade.x;
  if (floorH > 0.0) {
    float wallH = vFacade.y;
    float style = vFacade.z;
    float seed = vFacade.w;
    float u = vFacadeUv.x;
    float v = vFacadeUv.y;
    // Broad sun fading and restrained vertical staining, stable per building.
    float fade = smoothstep(0.0, wallH, v) * uWeathering;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78,0.74,0.64), fade * 0.25);
    float stripe = pow(0.5 + 0.5 * sin(u * 1.3 + seed * 6.0), 8.0);
    float stain = stripe * (0.35 + 0.65 * sin(v * 0.12 + seed) * sin(v * 0.12 + seed));
    diffuseColor.rgb *= 1.0 - uWeathering * stain * 0.25;
    // cornice: top band
    float cornice = step(wallH - 0.5, v) * step(v, wallH);
    diffuseColor.rgb *= mix(1.0, 0.86, cornice);
    float level = floor(v / floorH);
    float fv = fract(v / floorH);           // 0..1 within the floor
    float nLevels = floor(wallH / floorH + 0.001);
    bool topPartial = level >= nLevels;      // partial top floor: no windows
    bool ground = level < 0.5;
    float cellW = style == 2.0 ? 2.6 : (style == 4.0 ? 5.0 : 3.4);
    float cu = fract(u / cellW);
    float cell = floor(u / cellW);
    float lit = fhash(vec2(cell + seed * 13.0, level + seed * 7.0));
    float win = 0.0;
    if (!topPartial) {
      if (style == 2.0) {           // office: window bands
        win = step(0.22, fv) * step(fv, 0.82) * step(0.06, cu) * step(cu, 0.94);
      } else if (style == 4.0) {    // industrial: small high windows
        win = step(0.55, fv) * step(fv, 0.85) * step(0.15, cu) * step(cu, 0.85) * step(0.5, lit);
      } else {                      // punched windows
        win = step(0.28, fv) * step(fv, 0.78) * step(0.28, cu) * step(cu, 0.72);
      }
      if (style == 3.0 && ground) { // storefront glazing + awning band
        float glass = step(0.12, fv) * step(fv, 0.80) * step(0.06, cu) * step(cu, 0.94);
        float awning = step(0.80, fv) * step(fv, 0.92);
        win = glass;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7, awning);
      }
      // sill line under punched windows
      float sill = step(0.24, fv) * step(fv, 0.28) * step(0.24, cu) * step(cu, 0.76) * (style == 1.0 || style == 3.0 ? 1.0 : 0.0);
      if (style == 3.0 && ground) sill = 0.0;
      diffuseColor.rgb *= mix(1.0, 0.9, sill);
    }
    vec3 glass = mix(uGlass, diffuseColor.rgb * 0.45, 0.35);
    float isLit = step(0.62, lit) * uNight;
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * (1.0 - isLit));
    diffuseColor.rgb = mix(diffuseColor.rgb, uWindowLit, win * isLit);
    // night: darken unlit walls a touch
    diffuseColor.rgb *= mix(1.0, 0.85, uNight * (1.0 - win));
    #ifdef ISO_EMISSIVE
    totalEmissiveRadiance += uWindowLit * win * isLit * 0.9;
    #endif
  }
}
`;

export interface FacadeMaterial { material: THREE.MeshStandardMaterial; setNight(on: boolean): void }

export function createFacadeMaterial(): FacadeMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
  let uniforms: { [k: string]: THREE.IUniform } | null = null;
  let night = 0;
  material.customProgramCacheKey = () => 'iso-facade';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = { value: night };
    shader.uniforms.uWindowLit = { value: hex('window_lit') };
    shader.uniforms.uGlass = { value: hex('glass') };
    shader.uniforms.uWeathering = { value: regionId === 'honolulu' ? 0.5 : 0 };
    if (regionId === 'honolulu') shader.uniforms.uGlass.value = new THREE.Color('#849994');
    uniforms = shader.uniforms;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}\nattribute vec4 facade;\nattribute vec2 uv;`.replace('attribute vec2 uv;', '') )
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFacadeUv = uv;\nvFacade = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}\n${GLSL_FRAG}`)
      .replace('#include <color_fragment>', GLSL_WINDOWS)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n{ float w = 0.0; }');
  };
  // three only declares `uv` when a map is present; force the attribute via defines
  material.defines = { USE_UV: '', ISO_EMISSIVE: '' };
  return {
    material,
    setNight(on) { night = on ? 1 : 0; if (uniforms) uniforms.uNight.value = night; },
  };
}

export const PALETTE_KEYS = Object.keys(palette);
