import { parseStyle, type MapStyle } from './styles';
export type { MapStyle } from './styles';
export interface SearchPlace { id: string; name: string | null; addr: string | null; x: number; y: number; ground_z: number; landmark?: string | null }
export interface ViewState {
  region: string; x: number; y: number; z: number; zoom: number; az: number; distance: number;
  night: boolean; map: boolean; style: MapStyle; building?: string;
}

export function encodeView(s: ViewState): string {
  const p = new URLSearchParams({ view: '1', region: s.region, x: s.x.toFixed(2), y: s.y.toFixed(2), z: s.z.toFixed(2),
    zoom: s.zoom.toFixed(3), az: s.az.toFixed(4), distance: s.distance.toFixed(2), night: s.night ? '1' : '0',
    map: s.map ? '1' : '0', style: s.style });
  if (s.building) p.set('building', s.building);
  return `#${p}`;
}

export function decodeView(hash: string, region: string): ViewState | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (p.get('view') !== '1' || p.get('region') !== region) return null;
  const n = (k: string) => p.has(k) && p.get(k) !== '' ? Number(p.get(k)) : NaN;
  const x = n('x'), y = n('y'), z = n('z'), zoom = n('zoom'), az = n('az'), distance = n('distance');
  if (![x, y, z, zoom, az, distance].every(Number.isFinite) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7
    || z < -1000 || z > 10000 || zoom < 0.35 || zoom > 12 || distance < 100 || distance > 5500 || Math.abs(az) > 100) return null;
  return { region, x, y, z, zoom, az, distance, night: p.get('night') === '1', map: p.get('map') === '1',
    style: parseStyle(p.get('style')), building: p.get('building') || undefined };
}

export function searchPlaces(places: SearchPlace[], query: string): SearchPlace[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  return places.map((p) => {
    const name = (p.name ?? '').toLocaleLowerCase(), addr = (p.addr ?? '').toLocaleLowerCase();
    const text = `${name} ${addr}`;
    const score = name === q || addr === q ? 0 : name.startsWith(q) || addr.startsWith(q) ? 1 : 2;
    return { p, score, matches: words.every((w) => text.includes(w)) };
  }).filter((r) => r.matches).sort((a, b) => a.score - b.score || (a.p.name ?? a.p.addr ?? '').localeCompare(b.p.name ?? b.p.addr ?? ''))
    .slice(0, 8).map((r) => r.p);
}

export function createNavigation(root: HTMLElement, onSelect: (place: SearchPlace) => void, getView: () => ViewState) {
  const panel = document.createElement('div'); panel.className = 'panel navigation';
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = 'Search places or addresses';
  input.setAttribute('aria-label', 'Search places or addresses'); input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'place-results'); input.disabled = true;
  const share = document.createElement('button'); share.type = 'button'; share.textContent = 'Share view';
  const results = document.createElement('div'); results.id = 'place-results'; results.setAttribute('role', 'listbox'); results.hidden = true;
  const status = document.createElement('div'); status.className = 'navigation-status'; status.setAttribute('role', 'status');
  panel.append(input, share, results, status); root.append(panel);
  let places: SearchPlace[] = [], matches: SearchPlace[] = [], active = -1;
  const close = () => { results.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const choose = (p: SearchPlace) => { input.value = p.name ?? p.addr ?? ''; close(); input.blur(); onSelect(p); };
  const highlight = () => {
    [...results.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) input.setAttribute('aria-activedescendant', `place-option-${active}`);
  };
  input.addEventListener('input', () => {
    matches = searchPlaces(places, input.value); results.replaceChildren(); active = -1;
    status.textContent = input.value.trim() && !matches.length ? 'No matching places' : '';
    for (const [i, p] of matches.entries()) {
      const item = document.createElement('button'); item.type = 'button'; item.id = `place-option-${i}`;
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', 'false'); item.tabIndex = -1;
      const name = document.createElement('strong'); name.textContent = p.name ?? p.addr ?? 'Place';
      const detail = document.createElement('span'); detail.textContent = p.name ? p.addr ?? 'Landmark' : 'Address';
      item.append(name, detail); item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => choose(p)); results.append(item);
    }
    results.hidden = !matches.length; input.setAttribute('aria-expanded', String(matches.length > 0));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && matches.length) {
      e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; highlight();
    } else if (e.key === 'Enter' && matches.length && !results.hidden) { e.preventDefault(); choose(matches[Math.max(0, active)]); }
  });
  input.addEventListener('blur', close);
  let shareTimer: ReturnType<typeof setTimeout> | undefined;
  share.addEventListener('click', async () => {
    const url = new URL(location.href); url.hash = encodeView(getView()); history.replaceState(null, '', url);
    clearTimeout(shareTimer);
    try { await navigator.clipboard.writeText(url.href); status.textContent = 'View link copied'; }
    catch { status.textContent = 'Copy this view link:'; const link = document.createElement('input'); link.value = url.href;
      link.setAttribute('aria-label', 'Shareable view link'); link.readOnly = true; status.append(link); link.focus(); link.select(); }
    shareTimer = setTimeout(() => { status.textContent = ''; }, 8000);
  });
  return {
    setPlaces(data: SearchPlace[]) { places = data; input.disabled = false; },
    unavailable() { input.placeholder = 'Search unavailable'; status.textContent = 'Place index could not be loaded'; },
  };
}
