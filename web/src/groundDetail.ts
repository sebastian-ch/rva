import * as THREE from 'three';

/**
 * Cheap texture-free ground variety, injected into the land and terrain materials:
 * world-space value noise that mottles grass (lawn vs beds) and sand (worn paths), stronger on land polygons.
 * Chains with any existing onBeforeCompile (heights mode).
 */
export function applyGroundDetail(material: THREE.Material, strength = 0.08): void {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uGroundNoise = { value: strength };
    if (!shader.vertexShader.includes('vIsoWorld')) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vIsoWorld;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvIsoWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vIsoWorld;');
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uGroundNoise;
float gdHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gdNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gdHash(i), gdHash(i + vec2(1, 0)), f.x), mix(gdHash(i + vec2(0, 1)), gdHash(i + vec2(1, 1)), f.x), f.y);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float n = gdNoise(vIsoWorld.xz * 0.09) * 0.6 + gdNoise(vIsoWorld.xz * 0.31) * 0.4;
  // greens get darker beds in the low-noise regions, everything else a faint mottle
  float g = diffuseColor.g - max(diffuseColor.r, diffuseColor.b);
  float k = uGroundNoise * (1.0 + 2.0 * smoothstep(0.02, 0.12, g));
  diffuseColor.rgb *= 1.0 + (n - 0.5) * 2.0 * k;
}`);
  };
  const key = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${key ? key.call(material) : ''}|iso-ground`;
  material.needsUpdate = true;
}
