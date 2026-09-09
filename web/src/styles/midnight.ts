import { defineStyle } from './definition';

export default defineStyle({
  label: 'After Midnight',
  nightLighting: true, neonLighting: true, trafficTrails: true, roadRoughness: 0.15,
  bloom: { strength: 0.24, radius: 0.35, threshold: 0.48 },
  theme: { bg: '#150a26', alt: '#2e1a4a', border: '#704c8d', text: '#eae2fa', muted: '#b6a4cc', scheme: 'dark' },
  helpers: /* glsl */ ``,
  fragment: /* glsl */ `
        vec3 n = faceNormal(vUv);
        vec3 c = color.rgb;
        float light = max(c.r, max(c.g, c.b));
        float neon = smoothstep(0.48, 0.95, light) * smoothstep(0.18, 0.5, max(c.r, c.g) - min(c.r, c.g));
        vec3 cyan = vec3(0.035, 0.78, 1.0), pink = vec3(1.0, 0.045, 0.32);
        vec3 ink = mix(cyan, pink, step(c.g, c.r));
        // Dark violet volumes, slightly lifted roofs; retain relief in the terrain.
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        vec3 base = mix(vec3(0.012, 0.004, 0.027), vec3(0.036, 0.015, 0.074), clamp(l * 1.8 + abs(n.y) * 0.25, 0.0, 1.0));
        base *= ao * (1.0 - edge * 0.18);
        // Restrained cyan/magenta rims on horizontal roof edges.
        float rim = edge * step(0.75, abs(n.y)) * smoothstep(0.07, 0.24, l);
        base += mix(cyan, pink, step(0.5, fract(dot(worldAt(vUv).xz, vec2(0.003, 0.002))))) * rim * 0.22;
        // Screen-space wet-surface glow beneath nearby lights, depth-gated to horizontal surfaces.
        if (abs(n.y) > 0.9 && l < 0.3) {
          vec3 reflection = vec3(0.0);
          for (int i = 1; i <= 6; i++) {
            vec2 uv = vUv + vec2(sin(float(i) * 2.4) * 1.5, float(i) * 4.0) * px * uPixelRatio;
            vec3 sampleLight = texture2D(tDiffuse, uv).rgb;
            float strength = smoothstep(0.7, 1.2, max(sampleLight.r, max(sampleLight.g, sampleLight.b)));
            reflection += mix(cyan, pink, step(sampleLight.g, sampleLight.r)) * strength / float(i);
          }
          base += reflection * 0.09;
        }
        vec3 rgb = mix(base, ink * min(light, 2.0), neon);
        if (texture2D(tDepth, vUv).r > 0.99999) rgb = mix(vec3(0.007, 0.003, 0.019), vec3(0.040, 0.009, 0.080), 1.0 - vUv.y);
        rgb *= 1.0 - dot(vUv - 0.5, vUv - 0.5) * 0.35;
        gl_FragColor = vec4(rgb, color.a);
        return;
      `,
});
