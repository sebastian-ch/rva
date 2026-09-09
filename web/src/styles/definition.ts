export interface StyleDefinition {
  label: string;
  note: string | null;
  xray: boolean;
  moss: boolean;
  /** GLSL helpers have global scope; prefix new helper names to avoid collisions. */
  helpers: string;
  /** Runs inside the shared grade pass. Write linear gl_FragColor and return. */
  fragment: string;
  nightLighting: boolean;
  neonLighting: boolean;
  trafficTrails: boolean;
  roadRoughness: number;
  bloom: { strength: number; radius: number; threshold: number } | null;
  theme: { bg: string; alt: string; border: string; text: string; muted: string; scheme: 'light' | 'dark' } | null;
}

/** Copy a style module, customize its shader and settings, then register it in index.ts. */
export function defineStyle(style: Pick<StyleDefinition, 'label'> & Partial<StyleDefinition>): StyleDefinition {
  return { note: null, xray: false, moss: false, helpers: '', fragment: '', nightLighting: false, neonLighting: false,
    trafficTrails: false, roadRoughness: 0.95, bloom: null, theme: null, ...style };
}
