import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MAP_STYLES, STYLE_IDS, type MapStyle } from './styles';

/**
 * One full-screen pass for the flat-shaded look, with orthographic/perspective depth conversion:
 *  - depth-difference ambient occlusion (12 taps, radius in metres)
 *  - edge outline where depth jumps (buildings against ground, roof against wall)
 *  - warm colour grade + vignette; cooler, darker grade at night
 * Depth comes from a depth texture attached to the composer's render target.
 */
const IsoGradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 1 }, uFar: { value: 6000 },
    uMetersPerPixel: { value: 0.5 },
    uPerspective: { value: 0 },
    uStyle: { value: 0 }, uPixelRatio: { value: 1 },
    uInverseProjection: { value: new THREE.Matrix4() }, uCameraWorld: { value: new THREE.Matrix4() },
    uAo: { value: 0.32 }, uOutline: { value: 0.45 }, uGrade: { value: 1.0 }, uNight: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform vec2 uResolution; uniform float uNear; uniform float uFar; uniform float uMetersPerPixel;
    uniform float uPerspective;
    uniform float uStyle; uniform float uPixelRatio;
    uniform mat4 uInverseProjection; uniform mat4 uCameraWorld;
    uniform float uAo; uniform float uOutline; uniform float uGrade; uniform float uNight;
    varying vec2 vUv;
    // orthographic depth: linear in [near, far]
    float depthM(vec2 uv) {
      float z = texture2D(tDepth, uv).x;
      return uPerspective > 0.5 ? uNear * uFar / (uFar - z * (uFar - uNear))
        : uNear + z * (uFar - uNear);
    }
    vec3 worldAt(vec2 uv) {
      vec4 p = uInverseProjection * vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).r * 2.0 - 1.0, 1.0);
      return (uCameraWorld * vec4(p.xyz / p.w, 1.0)).xyz;
    }
    vec3 faceNormal(vec2 uv) {
      vec2 px = 1.0 / uResolution;
      vec3 p = worldAt(uv);
      return normalize(cross(worldAt(uv + vec2(px.x, 0.0)) - p, worldAt(uv + vec2(0.0, px.y)) - p));
    }

    ${STYLE_IDS.map((id) => MAP_STYLES[id].helpers).join('\n')}
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec2 px = 1.0 / uResolution;
      float d = depthM(vUv);
      float metersPerPixel = uMetersPerPixel * (uPerspective > 0.5 ? d : 1.0);
      // ---- ambient occlusion: how many nearby pixels are in front of us by more than a bias
      float radiusPx = clamp(1.6 / metersPerPixel, 2.0, 22.0);
      float occ = 0.0;
      const int N = 12;
      for (int i = 0; i < N; i++) {
        float a = 6.2831853 * (float(i) + 0.5) / float(N);
        float r = radiusPx * (0.35 + 0.65 * fract(float(i) * 0.618034));
        vec2 o = vec2(cos(a), sin(a)) * r * px;
        float dd = d - depthM(vUv + o);            // positive: neighbour is closer to the camera
        // contact occlusion only: neighbours 0.3–6 m in front (wall bases, under eaves), not whole towers
        occ += smoothstep(0.3, 1.2, dd) * (1.0 - smoothstep(4.0, 8.0, dd));
      }
      occ = occ / float(N);
      float ao = 1.0 - uAo * occ;
      // ---- outline: depth discontinuity to any 4-neighbour
      float e = 0.0;
      e = max(e, abs(d - depthM(vUv + vec2(px.x, 0.0))));
      e = max(e, abs(d - depthM(vUv - vec2(px.x, 0.0))));
      e = max(e, abs(d - depthM(vUv + vec2(0.0, px.y))));
      e = max(e, abs(d - depthM(vUv - vec2(0.0, px.y))));
      float edge = smoothstep(2.5, 8.0, e / max(metersPerPixel, 0.02) * 0.5);

      ${STYLE_IDS.map((id, index) => MAP_STYLES[id].fragment ? `if (abs(uStyle - ${index.toFixed(1)}) < 0.1) { ${MAP_STYLES[id].fragment} }` : '').join('\n')}
      vec3 rgb = color.rgb * ao;
      rgb = mix(rgb, rgb * 0.45, edge * uOutline);
      // ---- grade: warm lift by day, cool crush by night, gentle contrast, vignette
      vec3 day = rgb * vec3(1.05, 1.02, 0.97);
      vec3 night = rgb * vec3(0.88, 0.94, 1.08);
      rgb = mix(day, night, uNight);
      rgb = mix(rgb, (rgb - 0.5) * 1.03 + 0.5, uGrade);
      vec2 q = vUv - 0.5;
      float vig = 1.0 - dot(q, q) * (0.18 + 0.2 * uNight);
      rgb *= vig;
      gl_FragColor = vec4(rgb, color.a);
    }`,
};

export interface PostFX {
  composer: EffectComposer;
  setSize(w: number, h: number, pixelRatio: number): void;
  update(camera: THREE.OrthographicCamera | THREE.PerspectiveCamera, viewportHeight: number): void;
  setNight(on: boolean): void;
  setStyle(style: MapStyle): void;
  enabled: boolean;
}

export function createPostFX(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.OrthographicCamera | THREE.PerspectiveCamera): PostFX {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
    depthTexture: new THREE.DepthTexture(size.x * pr, size.y * pr, THREE.UnsignedIntType),
    samples: 0,
  });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  /** ShaderPass that reads depth from whichever buffer holds the scene this frame (the composer ping-pongs). */
  class GradePass extends ShaderPass {
    render(r: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime?: number, maskActive?: boolean) {
      this.uniforms.tDepth.value = readBuffer.depthTexture;
      super.render(r, writeBuffer, readBuffer, deltaTime as number, maskActive as boolean);
    }
  }
  const grade = new GradePass(IsoGradeShader);
  composer.addPass(grade);
  const bloom = new UnrealBloomPass(size, 0.24, 0.35, 0.48);
  bloom.enabled = false;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const fx: PostFX = {
    composer,
    enabled: true,
    setSize(w, h, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(w, h);
      grade.uniforms.uResolution.value.set(w * pixelRatio, h * pixelRatio);
      grade.uniforms.uPixelRatio.value = pixelRatio;
    },
    update(cam, viewportHeight) {
      grade.uniforms.uNear.value = cam.near;
      grade.uniforms.uFar.value = cam.far;
      grade.uniforms.uInverseProjection.value.copy(cam.projectionMatrixInverse);
      grade.uniforms.uCameraWorld.value.copy(cam.matrixWorld);
      // ortho: world metres per screen pixel = (top - bottom) / zoom / viewport height
      const perspective = cam instanceof THREE.PerspectiveCamera;
      grade.uniforms.uPerspective.value = perspective ? 1 : 0;
      grade.uniforms.uMetersPerPixel.value = (perspective
        ? 2 * Math.tan(THREE.MathUtils.degToRad(cam.getEffectiveFOV() / 2))
        : (cam.top - cam.bottom) / cam.zoom) / Math.max(1, viewportHeight);
    },
    setNight(on) { grade.uniforms.uNight.value = on ? 1 : 0; },
    setStyle(style) {
      grade.uniforms.uStyle.value = STYLE_IDS.indexOf(style);
      const settings = MAP_STYLES[style].bloom;
      bloom.enabled = settings !== null;
      if (settings) { bloom.strength = settings.strength; bloom.radius = settings.radius; bloom.threshold = settings.threshold; }
    },
  };
  fx.setSize(size.x, size.y, pr);
  return fx;
}
