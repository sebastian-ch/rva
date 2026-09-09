import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createWaterMaterial } from './water';

describe('createWaterMaterial', () => {
  it('returns a MeshStandardMaterial with vertexColors true', () => {
    const water = createWaterMaterial();
    expect(water.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(water.material.vertexColors).toBe(true);
  });

  it('allows update/setNight before compilation without throwing', () => {
    const water = createWaterMaterial();
    expect(() => water.update(1.5)).not.toThrow();
    expect(() => water.setNight(true)).not.toThrow();
  });

  it('injects noise + world position code on compile and wires uniforms', () => {
    const water = createWaterMaterial();
    water.update(1.5);
    water.setNight(true);

    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as any;

    water.material.onBeforeCompile!(shader, {} as any);

    expect(shader.fragmentShader).toContain('vnoise');
    expect(shader.fragmentShader).toContain('uTime');
    expect(shader.vertexShader).toContain('vWorldPos');
    expect(shader.uniforms.uTime.value).toBe(1.5);
    expect(shader.uniforms.uNight.value).toBe(1);
  });
});
