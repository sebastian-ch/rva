import { defineStyle } from './definition';

export default defineStyle({
  // Keep the URL key "terrarium" so earlier shared views remain valid.
  label: 'Overgrown',
  note: 'Abandoned Richmond · nature reclaiming the city',
  moss: true,
  theme: { bg: '#19211c', alt: '#29332b', border: '#58634f', text: '#e3e3d3', muted: '#a8ae98', scheme: 'dark' },
  helpers: /* glsl */ `
    float terrariumNoise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      vec3 k = vec3(127.1, 311.7, 43758.5453);
      return mix(mix(fract(sin(dot(i, k.xy))*k.z), fract(sin(dot(i+vec2(1,0), k.xy))*k.z), f.x),
        mix(fract(sin(dot(i+vec2(0,1), k.xy))*k.z), fract(sin(dot(i+vec2(1,1), k.xy))*k.z), f.x), f.y);
    }
  `,
  fragment: /* glsl */ `
    vec3 abandonedPosition = worldAt(vUv), abandonedNormal = faceNormal(vUv);
    float patches = terrariumNoise(abandonedPosition.xz * 0.055);
    float wear = terrariumNoise(abandonedPosition.xz * 0.32 + abandonedPosition.y * 0.008);
    float grain = terrariumNoise(abandonedPosition.xz * 2.0);
    float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    bool waterSurface = color.b > color.r * 1.18 && color.b > color.g * 1.03 && abs(abandonedNormal.y) > 0.7;
    bool vegetation = color.g > color.r * 1.12 && color.g > color.b * 1.12;
    bool horizontal = abs(abandonedNormal.y) > 0.75;
    vec3 leaf = mix(vec3(0.20,0.29,0.15),vec3(0.39,0.46,0.25),wear*0.65+grain*0.15);
    vec3 concrete = mix(vec3(0.31,0.32,0.29),vec3(0.57,0.56,0.48),clamp(luminance*1.6,0.0,1.0));
    // Rain streaks run down the facade; broad damp patches break up the clean volumes.
    float streak = pow(terrariumNoise(abandonedPosition.xz * 0.8),3.0);
    concrete *= 0.83 + wear*0.12 - streak*0.17;
    vec3 abandonedColor = concrete;
    if (horizontal) {
      vec3 exposed = luminance < 0.12 ? vec3(0.22,0.235,0.205) : concrete * 1.08;
      float reclaimed = smoothstep(0.44,0.66,patches+wear*0.12);
      abandonedColor = mix(exposed,leaf,reclaimed*0.88);
      // Fine broken seams, with soil and moss collecting in the cracks.
      float cracks = 1.0-smoothstep(0.012,0.035,abs(terrariumNoise(abandonedPosition.xz*0.23)-0.5));
      abandonedColor *= 1.0-cracks*0.12;
    }
    if (vegetation && (horizontal || abs(abandonedNormal.y)>0.1)) abandonedColor=leaf;
    if (waterSurface) abandonedColor=vec3(0.13,0.23,0.205)*(0.9+wear*0.07);
    abandonedColor *= (0.78+ao*0.22)*(1.0-edge*0.12);
    float vignette = smoothstep(0.15,0.72,length(vUv-0.5))*0.40;
    abandonedColor = mix(abandonedColor,vec3(0.07,0.10,0.075),vignette);
    if(texture2D(tDepth,vUv).r>0.99999) abandonedColor=mix(vec3(0.27,0.31,0.25),vec3(0.07,0.10,0.075),length(vUv-0.5)*1.4);
    gl_FragColor=vec4(pow(max(abandonedColor,vec3(0)),vec3(2.2)),color.a);
    return;
  `,
});
