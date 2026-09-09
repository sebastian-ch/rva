import { defineStyle } from './definition';

export default defineStyle({
  label: 'X-ray',
  xray: true,
  note: 'Illustrative floors · reported levels where available',
  theme: { bg: '#070c12', alt: '#0a2230', border: '#3b7d99', text: '#c2eafa', muted: '#83a7ba', scheme: 'dark' },
  bloom: { strength: 0.18, radius: 0.3, threshold: 0.5 },
  fragment: /* glsl */ `
    // Glass and interiors are real additive geometry; preserve their accumulated light.
    vec3 xrayColor = color.rgb;
    float cyanSignal = max(0.0, min(xrayColor.g, xrayColor.b) - xrayColor.r);
    float orangeSignal = max(0.0, xrayColor.r - max(xrayColor.g, xrayColor.b));
    float context = dot(xrayColor, vec3(0.2126, 0.7152, 0.0722));
    vec3 xrayBase = vec3(0.002, 0.006, 0.010) + vec3(0.008, 0.025, 0.035) * min(context, 0.4);
    xrayBase += vec3(0.34, 0.79, 1.0) * cyanSignal * 1.7;
    xrayBase += vec3(1.0, 0.35, 0.075) * orangeSignal * 1.8;
    xrayBase *= 1.0 - dot(vUv - 0.5, vUv - 0.5) * 0.4;
    gl_FragColor = vec4(xrayBase, color.a);
    return;
  `,
});
