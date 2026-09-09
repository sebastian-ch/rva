export interface WikiSummary {
  title: string;
  summary: string;
  thumbnail: string | null;
  url: string;
}

const cache = new Map<string, WikiSummary | null>();
const TIMEOUT_MS = 6000;

async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Looks up an English Wikipedia summary for a Wikidata QID: resolves the enwiki
 * sitelink via the Wikidata entity data endpoint, then fetches the REST summary.
 * Errors and missing data are swallowed and return null. Results are cached by QID.
 */
export async function fetchWikiSummary(wikidataId: string): Promise<WikiSummary | null> {
  if (cache.has(wikidataId)) return cache.get(wikidataId)!;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const entityUrl = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(wikidataId)}.json`;
    const entityData = await getJson(entityUrl, controller.signal);
    const title: string | undefined = entityData?.entities?.[wikidataId]?.sitelinks?.enwiki?.title;
    if (!title) {
      cache.set(wikidataId, null);
      return null;
    }

    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const summaryData = await getJson(summaryUrl, controller.signal);
    const result: WikiSummary = {
      title: summaryData.title ?? title,
      summary: summaryData.extract ?? '',
      thumbnail: summaryData.thumbnail?.source ?? null,
      url: summaryData.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    };
    cache.set(wikidataId, result);
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
