import regions from '../../regions.json';

export const regionId = (import.meta.env.VITE_REGION ?? 'richmond') as keyof typeof regions;
export const region = regions[regionId];
