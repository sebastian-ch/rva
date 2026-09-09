import * as THREE from 'three';

/** A camera-centered day sky; fixed world directions keep clouds stable while orbiting. */
export function createTropicalSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDirection;
      float puff(vec2 p, vec2 center, vec2 size) {
        return 1.0 - smoothstep(0.75, 1.0, length((p-center)/size));
      }
      float cloud(vec3 ray, vec3 center, float scale) {
        center = normalize(center);
        vec3 right = normalize(cross(vec3(0.0,1.0,0.0),center));
        vec3 up = cross(center,right);
        vec3 delta = ray-center;
        vec2 p = vec2(dot(delta,right),dot(delta,up))/scale;
        float a = puff(p,vec2(-0.7,0.0),vec2(0.85,0.34));
        a = max(a,puff(p,vec2(0.05,0.18),vec2(0.65,0.55)));
        a = max(a,puff(p,vec2(0.73,0.02),vec2(0.85,0.37)));
        a = max(a,puff(p,vec2(0.0,-0.13),vec2(1.38,0.26)));
        return a * smoothstep(0.8,0.95,dot(ray,center));
      }
      void main() {
        vec3 ray = normalize(vDirection);
        float h = pow(clamp(ray.y,0.0,1.0),0.55);
        vec3 color = mix(vec3(0.64,0.86,0.96),vec3(0.12,0.48,0.83),h);
        vec3 sunDir = normalize(vec3(0.96,0.25,0.55));
        float distanceToSun = length(ray-sunDir);
        color += vec3(0.20,0.15,0.04)*exp(-distanceToSun*distanceToSun/0.012);
        float disk = 1.0-smoothstep(0.021,0.026,distanceToSun);
        color = mix(color,vec3(1.0,0.95,0.65),disk);
        float c = cloud(ray,vec3(0.23,0.27,0.95),0.09);
        c = max(c,cloud(ray,vec3(0.75,0.25,0.85),0.065));
        c = max(c,cloud(ray,vec3(0.95,0.17,0.12),0.08));
        c = max(c,cloud(ray,vec3(-0.7,0.28,0.4),0.09));
        c = max(c,cloud(ray,vec3(0.1,0.22,-0.9),0.08));
        color = mix(color,vec3(0.99,0.995,1.0),c*0.92);
        gl_FragColor = vec4(color,1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(5500, 24, 12), material);
  mesh.name = 'tropical-sky';
  mesh.renderOrder = -10000;
  mesh.frustumCulled = false;
  return mesh;
}
