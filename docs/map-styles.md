# Adding a map style

Styles live in `web/src/styles/`. There was a shared postprocessing pass before this refactor;
the registry now also owns labels, URL identifiers, dropdown order, UI colors, lighting,
road roughness, traffic trails, and bloom settings.

Add one style module and register it in `index.ts`. The toolbar, share-link parser and scene
settings consume that registry automatically. Use a stable lowercase key: shared URLs store
the key, not its numeric shader index. Unknown style keys safely open Classic.

## Minimal template

Copy this into `web/src/styles/my-style.ts`:

```ts
import { defineStyle } from './definition';

export default defineStyle({
  label: 'My Style',
  theme: {
    bg: '#e6dcc4', alt: '#f6efdf', border: '#b6aa8c',
    text: '#403c32', muted: '#736b58', scheme: 'light',
  },
  fragment: /* glsl */ `
    vec3 myColor = color.rgb * ao;
    gl_FragColor = vec4(myColor, color.a);
    return;
  `,
});
```

Import it into `styles/index.ts` and add `myStyle` to `MAP_STYLES` with the desired stable key.
Registry order determines the dropdown order. No changes to navigation, UI, main, or postfx
are needed for a style using the existing rendering inputs.

`crossstitch.ts` is the complete print-style example. `midnight.ts` demonstrates optional
`nightLighting`, `neonLighting`, `trafficTrails`, `roadRoughness`, and `bloom` settings.
The defaults come from `defineStyle`: ordinary day/night choice, no trails or bloom, matte roads.

## Shader contract

The fragment runs inside a block in the shared grade shader. Available values are:

- `color`: linear scene RGBA; `vUv`: screen UV; `px`: one physical pixel in UV units.
- `ao`, `edge`, `d`, and `metersPerPixel`: shared depth-based shading information.
- `tDiffuse`, `tDepth`, `uResolution`, `uPixelRatio`, `uNight`: textures and frame uniforms.
- `worldAt(uv)`, `faceNormal(uv)`, `depthM(uv)`: position/normal/depth helpers.

Write `gl_FragColor` in **linear** color space, then `return`. Convert an sRGB print palette
to linear before output, as Cross-stitch and Risograph do. The composer applies output
conversion once. Prefix optional global `helpers` functions with a style-specific name
to prevent collisions. Fragment-local variables are isolated by their block.

Cross-stitch samples the scene at the center of each five-CSS-pixel cell, so geometry edges
and color changes use the same grid. The render target has no multisample antialiasing;
the stitch strands and linen weave are drawn within each cell. Labels and UI render afterward
and remain readable. Screen-space print textures stay fixed to the display when panning.

Heights mode returns to Classic to preserve the elevation legend. After Midnight forces
night lighting while active, then restores the user's independent day/night preference.
New geometry passes or additional material effects still require renderer work; the
template covers styles built from the existing scene, depth, lighting, and postprocessing.

## Review

Run `npm run typecheck`, `npm test`, and `npm run build` from `web/`. Share-link round-trip
tests iterate every registered style. With the Richmond dev server running, use
`node tools/review-richmond.mjs` for desktop/mobile screenshots and shader error checks.
Add a screenshot and share/reload assertion for a new style to that review script.

## Geometry styles

`xray` enables a separate cached building layer, replacing ordinary building shells and landmark
models with footprint-based glass volumes. Transparent additive walls have `depthWrite: false`;
merged cyan floor plates/perimeters and instanced orange cores expose internal levels. Buildings
18 m and taller get plates. Plausible reported floor counts win (2.2–6 m per level); otherwise
spacing is estimated at roughly 3.6 m, capped at 80 levels. Courtyard holes remain empty. These are
illustrative interiors, not surveyed slabs or elevator locations. Geometry is generated only while
needed and disposed on style changes and tile unloading.

`terrarium` remains the stable URL key, but its display name is now **Overgrown**. The original
uniform moss treatment was replaced by weathered stone, rain stains, dark glazing, patchy reclaimed
roofs/roads, rooftop shrubs, and hanging vines on procedural facades. Instanced vegetation is capped
per tile. Detailed landmark models receive the shader treatment; the added vines/shrubs use procedural
building surfaces. The city geometry stays intact—this is an abandoned-city art treatment.

`paper` uses a three-value cardstock ramp, crease outlines and short contact shadows. The dropdown
is a native labeled select, supports keyboard navigation, and remains usable on narrow screens.
