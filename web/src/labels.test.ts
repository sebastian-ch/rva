import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LandmarkLabels, labelScale } from './labels';

describe('labelScale', () => {
  it('scales pixel dimensions to world units using 800 world units per viewport height at zoom 1', () => {
    const viewportHeight = 900;
    const zoom = 2;
    const worldPerPixel = 800 / (viewportHeight * zoom);
    const [w, h] = labelScale(120, 40, viewportHeight, zoom);
    expect(w).toBeCloseTo(120 * worldPerPixel);
    expect(h).toBeCloseTo(40 * worldPerPixel);
  });

  it('shrinks as zoom increases (constant on-screen size)', () => {
    const [wLow] = labelScale(100, 30, 900, 1);
    const [wHigh] = labelScale(100, 30, 900, 4);
    expect(wHigh).toBeLessThan(wLow);
    expect(wHigh).toBeCloseTo(wLow / 4);
  });
});

describe('LandmarkLabels', () => {
  it('is hidden below zoom 2 and visible at/above it', () => {
    const labels = new LandmarkLabels();
    labels.set('capitol', 'Virginia State Capitol', new THREE.Vector3(1, 2, 3));
    labels.update(1.9, false);
    expect(labels.group.visible).toBe(false);
    labels.update(2, false);
    expect(labels.group.visible).toBe(true);
  });

  it('positions the sprite above the given point', () => {
    const labels = new LandmarkLabels();
    labels.set('capitol', 'Virginia State Capitol', new THREE.Vector3(1, 2, 3));
    const sprite = labels.group.children[0] as THREE.Sprite;
    expect(sprite.position.x).toBeCloseTo(1);
    expect(sprite.position.y).toBeCloseTo(16); // 2 + 14
    expect(sprite.position.z).toBeCloseTo(3);
  });

  it('set() does not throw without a DOM canvas (node test environment)', () => {
    const labels = new LandmarkLabels();
    expect(() => labels.set('a', 'A Building', new THREE.Vector3())).not.toThrow();
    expect(() => labels.update(3, true)).not.toThrow();
  });

  it('remove() drops the sprite from the group', () => {
    const labels = new LandmarkLabels();
    labels.set('a', 'A', new THREE.Vector3());
    expect(labels.group.children.length).toBe(1);
    labels.remove('a');
    expect(labels.group.children.length).toBe(0);
  });
});
