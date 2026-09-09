import { defineStyle } from './definition';
import risograph from './risograph';
import midnight from './midnight';
import paper from './paper';
import terrarium from './terrarium';
import xray from './xray';
import crossstitch from './crossstitch';

/** Stable keys are saved in shared URLs. Order controls the toolbar cycle. */
export const MAP_STYLES = {
  classic: defineStyle({ label: 'Classic' }),
  risograph,
  midnight,
  crossstitch,
  terrarium,
  xray,
  paper,
};
export type MapStyle = keyof typeof MAP_STYLES;
export const STYLE_IDS = Object.keys(MAP_STYLES) as MapStyle[];
export function parseStyle(value: string | null): MapStyle {
  return value !== null && Object.hasOwn(MAP_STYLES, value) ? value as MapStyle : 'classic';
}
export function nextStyle(style: MapStyle): MapStyle {
  return STYLE_IDS[(STYLE_IDS.indexOf(style) + 1) % STYLE_IDS.length];
}
