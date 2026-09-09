import { defineStyle } from './definition';

export default defineStyle({
  label: 'Cross-stitch',
  theme: { bg: '#e6dcc4', alt: '#f6efdf', border: '#b6aa8c', text: '#403c32', muted: '#736b58', scheme: 'light' },
  fragment: /* glsl */ `
    // Quantize every scene lookup before palette selection: silhouettes share the stitch grid.
    vec2 stitchPixel = floor(gl_FragCoord.xy / (5.0 * uPixelRatio));
    vec2 stitchUv = (stitchPixel + 0.5) * 5.0 * uPixelRatio / uResolution;
    vec3 thread = vec3(0.902, 0.863, 0.769);
    vec3 stitchColor = texture2D(tDiffuse, stitchUv).rgb;
    vec3 stitchNormal = faceNormal(stitchUv);
    float stitchLuma = dot(stitchColor, vec3(0.2126, 0.7152, 0.0722));
    vec3 redThread = vec3(0.773, 0.314, 0.290);
    vec3 goldThread = vec3(0.863, 0.682, 0.373);
    vec3 blueThread = vec3(0.373, 0.494, 0.549);
    if (texture2D(tDepth, stitchUv).r < 0.99999) {
      bool blueSurface = stitchColor.b > stitchColor.r * 1.12;
      bool greenSurface = stitchColor.g > stitchColor.r * 1.12 && stitchColor.g > stitchColor.b * 1.12;
      if (blueSurface || greenSurface) thread = blueThread;
      else if (abs(stitchNormal.y) < 0.75) thread = stitchNormal.x + stitchNormal.z * 0.3 > 0.0 ? redThread : blueThread;
      else if (stitchLuma < 0.2) thread = goldThread;
      // Broad face shading remains inside the same three thread colors.
      float shade = 0.76 + 0.24 * clamp(abs(stitchNormal.y) + abs(stitchNormal.x) * 0.6, 0.0, 1.0);
      thread *= shade;
    }
    vec2 cell = fract(gl_FragCoord.xy / (5.0 * uPixelRatio));
    // Two diagonal strands, a darker puncture at each corner, and a fine linen weave.
    float strandA = 1.0 - smoothstep(0.10, 0.25, abs(cell.x - cell.y));
    float strandB = 1.0 - smoothstep(0.10, 0.25, abs(cell.x + cell.y - 1.0));
    float holes = (1.0 - smoothstep(0.03, 0.14, length(min(cell, 1.0 - cell))));
    float weave = sin(cell.x * 6.2831853) * sin(cell.y * 6.2831853);
    thread *= 0.88 + strandA * 0.14 + strandB * 0.08 + weave * 0.035 - holes * 0.16;
    gl_FragColor = vec4(pow(clamp(thread, 0.0, 1.0), vec3(2.2)), color.a);
    return;
  `,
});
