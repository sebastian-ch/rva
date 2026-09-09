import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWikiSummary } from './wiki';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

describe('fetchWikiSummary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves the enwiki sitelink then fetches the REST summary', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({ entities: { Q1: { sitelinks: { enwiki: { title: 'Virginia State Capitol' } } } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          title: 'Virginia State Capitol',
          extract: 'A neoclassical capitol building.',
          thumbnail: { source: 'https://example.com/thumb.jpg' },
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Virginia_State_Capitol' } },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWikiSummary('Q1');
    expect(result).toEqual({
      title: 'Virginia State Capitol',
      summary: 'A neoclassical capitol building.',
      thumbnail: 'https://example.com/thumb.jpg',
      url: 'https://en.wikipedia.org/wiki/Virginia_State_Capitol',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('Special:EntityData/Q1.json');
    expect(fetchMock.mock.calls[1][0]).toContain('/page/summary/Virginia%20State%20Capitol');
  });

  it('returns null when there is no enwiki sitelink', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ entities: { Q2: { sitelinks: {} } } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWikiSummary('Q2');
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows network errors and returns null', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWikiSummary('Q3');
    expect(result).toBeNull();
  });

  it('caches a result and does not refetch on the second call', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({ entities: { Q4: { sitelinks: { enwiki: { title: 'Old City Hall' } } } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ title: 'Old City Hall', extract: 'A gothic building.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Old_City_Hall' } } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchWikiSummary('Q4');
    const second = await fetchWikiSummary('Q4');
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
