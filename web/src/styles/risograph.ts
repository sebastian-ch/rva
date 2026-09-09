import { defineStyle } from './definition';

export default defineStyle({
  label: 'Risograph',
  theme: { bg: '#f4efe2', alt: '#fffaf0', border: '#d3cdbf', text: '#1f1c1a', muted: '#777268', scheme: 'light' },
  helpers: /* glsl */ `    vec2 inks(vec2 uv) {
      if (texture2D(tDepth, uv).r > 0.99999) return vec2(0.0);
      vec3 c = texture2D(tDiffuse, uv).rgb;
      vec3 n = faceNormal(uv);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      bool water = c.b > c.r * 1.18 && c.b > c.g * 1.03;
      bool foliage = c.g > c.r * 1.12 && c.g > c.b * 1.12;
      if (water && abs(n.y) > 0.72) return vec2(0.0, 0.28);
      if (foliage) return vec2(0.0, abs(n.y) > 0.96 ? 0.18 : 0.60);
      if (abs(n.y) > 0.72) return vec2(0.0, l < 0.18 ? 0.68 : 0.0);
      return n.x + n.z * 0.3 > 0.0 ? vec2(0.96, 0.0) : vec2(0.0, 0.96);
    }`,
  fragment: /* glsl */ `
        vec2 css = gl_FragCoord.xy / uPixelRatio;
        vec2 offset = px * uPixelRatio * 1.25;
        float redInk = inks(vUv + offset).x;
        float blueInk = inks(vUv - vec2(offset.x, -offset.y)).y;
        // Four CSS-pixel dot screen, fixed to the printed page rather than the world.
        float dotDistance = length(fract(css / 4.0) - 0.5);
        float dots = 1.0 - smoothstep(0.17, 0.24, dotDistance);
        vec3 paper = vec3(0.957, 0.937, 0.886);
        vec3 red = vec3(0.910, 0.314, 0.227), blue = vec3(0.247, 0.357, 0.788), black = vec3(0.122, 0.110, 0.102);
        vec3 printColor = mix(paper, red, redInk);
        printColor *= mix(vec3(1.0), blue / paper, blueInk);
        float normalEdge = 0.0;
        if (texture2D(tDepth, vUv).r < 0.99999) {
          vec3 n = faceNormal(vUv);
          normalEdge = max(1.0 - dot(n, faceNormal(vUv + vec2(px.x, 0.0))), 1.0 - dot(n, faceNormal(vUv + vec2(0.0, px.y))));
        }
        float outline = max(edge * 0.88, smoothstep(0.35, 0.85, normalEdge) * 0.72);
        printColor = mix(printColor, black, max(outline, dots * 0.14));
        float grain = fract(sin(dot(floor(css), vec2(12.9898, 78.233))) * 43758.5453);
        printColor *= 0.984 + grain * 0.025;
        gl_FragColor = vec4(pow(max(printColor, vec3(0.0)), vec3(2.2)), color.a);
        return;
      `,
});
