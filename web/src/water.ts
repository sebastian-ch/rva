import * as THREE from 'three';
import { hex } from './props';

export interface WaterMaterial {
  material: THREE.MeshStandardMaterial;
  update(timeSeconds: number): void;
  setNight(on: boolean): void;
}

const VNOISE_GLSL = `
float vhash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = vhash(i);
  float b = vhash(i + vec2(1.0, 0.0));
  float c = vhash(i + vec2(0.0, 1.0));
  float d = vhash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

export function createWaterMaterial(): WaterMaterial {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.35,
    metalness: 0.05,
  });

  type WaterUniforms = {
    uTime: { value: number };
    uNight: { value: number };
    uFoam: { value: THREE.Color };
    uDeep: { value: THREE.Color };
  };
  let uniforms: WaterUniforms | null = null;
  let pendingTime = 0;
  let pendingNight = 0;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: pendingTime };
    shader.uniforms.uNight = { value: pendingNight };
    shader.uniforms.uFoam = { value: hex('lane_paint') };
    shader.uniforms.uDeep = { value: hex('water_deep') };

    uniforms = shader.uniforms as unknown as WaterUniforms;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vWorldPos;'
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n\tvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWorldPos;\nuniform float uTime;\nuniform float uNight;\nuniform vec3 uFoam;\nuniform vec3 uDeep;\n${VNOISE_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
	{
		float n1 = vnoise(vWorldPos.xz * 0.06 + uTime * vec2(0.03, 0.012));
		float n2 = vnoise(vWorldPos.xz * 0.15 - uTime * vec2(0.02, 0.05));
		float n = 0.6 * n1 + 0.4 * n2;
		diffuseColor.rgb = mix(diffuseColor.rgb, uDeep, smoothstep(0.35, 0.75, n) * 0.6);
		diffuseColor.rgb = mix(diffuseColor.rgb, uFoam, smoothstep(0.88, 0.94, n2) * 0.55);
		diffuseColor.rgb *= mix(1.0, 0.45, uNight);
	}`
      );
  };

  material.customProgramCacheKey = () => 'iso-water';

  return {
    material,
    update(timeSeconds: number) {
      pendingTime = timeSeconds;
      if (uniforms) uniforms.uTime.value = timeSeconds;
    },
    setNight(on: boolean) {
      pendingNight = on ? 1 : 0;
      if (uniforms) uniforms.uNight.value = pendingNight;
    },
  };
}
