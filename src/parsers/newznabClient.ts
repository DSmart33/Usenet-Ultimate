/**
 * Newznab XML parsing and indexer capabilities discovery.
 *
 * Provides shared parsers for Newznab RSS XML responses, including
 * pagination metadata extraction and the ?t=caps endpoint.
 */

import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { NZBSearchResult, IndexerCaps } from '../types.js';
import { config } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { getAxiosProxyConfig } from '../proxy.js';

// Parsed response with pagination metadata
export interface NewznabParsedResponse {
  results: NZBSearchResult[];
  total?: number;    // from <newznab:response total="...">
  offset?: number;   // from <newznab:response offset="...">
}

// Shared Newznab XML parser with pagination metadata
// Extracts NZBSearchResult[] plus total/offset from <newznab:response>
export async function parseNewznabXmlWithMeta(xmlData: string): Promise<NewznabParsedResponse> {
  const parsed = await parseStringPromise(xmlData);

  // Extract pagination from <newznab:response offset="0" total="500" />
  let total: number | undefined;
  let offset: number | undefined;
  const newznabResponse = parsed.rss?.channel?.[0]?.['newznab:response']?.[0];
  if (newznabResponse?.$) {
    total = parseInt(newznabResponse.$.total, 10) || undefined;
    offset = parseInt(newznabResponse.$.offset, 10) || undefined;
  }

  if (!parsed.rss?.channel?.[0]?.item) {
    return { results: [], total, offset };
  }

  const items = parsed.rss.channel[0].item;

  const results = items.map((item: any) => {
    const attrs: any = {};

    // Collect attributes from all possible namespaced element sources.
    // NZBHydra2 may use different element names depending on version/config.
    const attrSources = [
      item['newznab:attr'],
      item['newznab:attrs'],
      item['nzbhydra:attr'],
      item['nzbhydra:attrs'],
      item.attr,
      item.attrs,
    ];
    for (const source of attrSources) {
      if (!Array.isArray(source)) continue;
      for (const attr of source) {
        if (attr?.$?.name && attr.$.value !== undefined) {
          const key = attr.$.name.toLowerCase();
          if (attrs[key] === undefined) attrs[key] = attr.$.value;
        }
      }
    }

    // Size: prefer newznab:attr, fall back to <enclosure length="...">
    const enclosureLength = item.enclosure?.[0]?.$?.length;
    const size = parseInt(attrs.size || enclosureLength || '0', 10);

    return {
      title: item.title?.[0] || '',
      link: item.link?.[0] || item.guid?.[0]?._ || item.guid?.[0] || '',
      size,
      pubDate: item.pubDate?.[0] || '',
      category: attrs.category || '',
      attributes: attrs,
    };
  });

  return { results, total, offset };
}

// Backward-compatible wrapper — extracts NZBSearchResult[] only
// Used by NzbhydraSearcher and other consumers that don't need pagination
export async function parseNewznabXml(xmlData: string): Promise<NZBSearchResult[]> {
  const { results } = await parseNewznabXmlWithMeta(xmlData);
  return results;
}

/**
 * Fetch indexer capabilities via the Newznab ?t=caps endpoint.
 * Parses the <searching> block to discover supported params for movie-search and tv-search.
 */
export async function fetchIndexerCaps(
  url: string,
  apiKey: string,
  indexerName?: string,
  zyclops?: import('../types.js').ZyclopsIndexerConfig
): Promise<IndexerCaps> {
  const userAgent = config.userAgents?.indexerSearch || getLatestVersions().chrome;

  // Determine effective URL: use Zyclops proxy if enabled
  let effectiveUrl = url;
  let extraParams: Record<string, string> = {};
  const isZyclops = zyclops?.enabled === true;

  if (isZyclops) {
    const zyclopsEndpoint = config.zyclopsEndpoint || 'https://zyclops.elfhosted.com';
    effectiveUrl = `${zyclopsEndpoint.replace(/\/$/, '')}/api`;
    extraParams = { target: url };
    if (zyclops.backbone) extraParams.backbone = zyclops.backbone;
    else if (zyclops.providerHost) extraParams.provider_host = zyclops.providerHost;
    console.log(`🤖 Fetching caps via Zyclops for ${indexerName || 'unknown'}: ${url} → ${effectiveUrl}`);
  }

  const response = await axios.get(effectiveUrl, {
    params: { t: 'caps', apikey: apiKey, ...extraParams },
    timeout: isZyclops ? 30000 : 10000,
    headers: { 'User-Agent': userAgent },
    ...(isZyclops ? {} : getAxiosProxyConfig(url, indexerName)),
  });

  const parsed = await parseStringPromise(response.data);

  const caps: IndexerCaps = {
    movieSearchParams: [],
    tvSearchParams: [],
  };

  const searching = parsed?.caps?.searching?.[0];
  if (!searching) {
    console.warn('⚠️  No <searching> block found in caps response');
    return caps;
  }

  // Parse <movie-search supportedParams="q,imdbid,tmdbid" />
  const movieSearch = searching['movie-search']?.[0];
  if (movieSearch?.$) {
    const available = movieSearch.$.available;
    if (available === 'yes' && movieSearch.$.supportedParams) {
      caps.movieSearchParams = movieSearch.$.supportedParams
        .split(',')
        .map((p: string) => p.trim().toLowerCase())
        .filter(Boolean);
    }
  }

  // Parse <tv-search supportedParams="q,tvdbid,imdbid,season,ep" />
  const tvSearch = searching['tv-search']?.[0];
  if (tvSearch?.$) {
    const available = tvSearch.$.available;
    if (available === 'yes' && tvSearch.$.supportedParams) {
      caps.tvSearchParams = tvSearch.$.supportedParams
        .split(',')
        .map((p: string) => p.trim().toLowerCase())
        .filter(Boolean);
    }
  }

  console.log(`🔍 Caps discovered: movie=[${caps.movieSearchParams.join(', ')}], tv=[${caps.tvSearchParams.join(', ')}]`);
  return caps;
}
