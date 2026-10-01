/**
 * Search module for screenshot-memory
 * Keyword search, vector search, and reciprocal rank fusion over the local SQLite index.
 */

import { memoryExists } from "./memory.js";
import { SearchStore, type StoredHit } from "./search-store.js";
import {
  getConfig,
  logger,
  SearchError,
  MemoryNotInitializedError,
} from "../utils/index.js";
import { getLocalEmbedder } from "../embeddings/ollama.js";

export type SearchMode = "lex" | "sem" | "auto";

export interface SearchOptions {
  /** Search mode: lex (lexical), sem (semantic), auto (hybrid) */
  mode?: SearchMode;
  /** Number of results to return */
  limit?: number;
  /** Minimum relevancy score (0-1) */
  minRelevancy?: number;
  /** Maximum snippet length */
  snippetChars?: number;
  /** Enable adaptive retrieval */
  adaptive?: boolean;
  /** Adaptive strategy */
  adaptiveStrategy?: "relative" | "absolute" | "cliff" | "elbow" | "combined";
}

export interface SearchHit {
  /** Document ID */
  id: string;
  /** Document title (filename) */
  title: string;
  /** Text snippet */
  snippet: string;
  /** Relevancy score */
  score: number;
  /** Number of keyword matches */
  matches?: number;
  /** Auto-extracted tags */
  tags?: string[];
  /** Labels */
  labels?: string[];
  /** Document metadata */
  metadata: {
    path: string;
    timestamp: number;
    fileSize?: number;
    width?: number;
    height?: number;
    confidence?: number;
  };
}

export interface SearchResult {
  /** Original query */
  query: string;
  /** Search mode used */
  mode: SearchMode;
  /** Search hits */
  hits: SearchHit[];
  /** Total number of matches */
  totalHits: number;
  /** Time taken in milliseconds */
  tookMs: number;
}

/**
 * Search for screenshots
 */
export async function search(
  query: string,
  options?: SearchOptions
): Promise<SearchResult> {
  const startTime = Date.now();
  const config = getConfig();

  if (!memoryExists()) {
    throw new MemoryNotInitializedError();
  }

  if (!query || query.trim().length === 0) {
    throw new SearchError("Search query cannot be empty");
  }

  const searchOptions = {
    mode: options?.mode || config.search.defaultMode,
    limit: options?.limit || config.search.defaultLimit,
    minRelevancy: options?.minRelevancy || config.search.minRelevancy,
    snippetChars: options?.snippetChars || config.search.snippetChars,
  };

  logger.debug(`Searching for "${query}" with mode: ${searchOptions.mode}`);

  const store = await SearchStore.open(config.memoryPath);
  try {
    const fetchLimit = Math.max(searchOptions.limit * 3, searchOptions.limit);
    const mode = searchOptions.mode as SearchMode;
    let stored: StoredHit[];
    if (mode === "lex") {
      stored = store.searchLex(query, fetchLimit);
    } else if (mode === "sem") {
      const embedding = await getLocalEmbedder().embedQuery(query);
      stored = store.searchSem(embedding, fetchLimit);
    } else {
      const embedding = await getLocalEmbedder().embedQuery(query);
      stored = store.searchHybrid(query, embedding, fetchLimit);
    }

    const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    const hits = stored
      .map((hit) => toSearchHit(hit, tokens, searchOptions.snippetChars))
      .filter((hit) => hit.score >= searchOptions.minRelevancy)
      .slice(0, searchOptions.limit);

    return {
      query,
      mode,
      hits,
      totalHits: hits.length,
      tookMs: Date.now() - startTime,
    };
  } catch (err) {
    if (err instanceof SearchError || err instanceof MemoryNotInitializedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new SearchError(`Search failed: ${message}`);
  } finally {
    store.close();
  }
}

/**
 * Search, then attach the stored text for each hit.
 */
export async function searchWithContext(
  query: string,
  options?: SearchOptions & { contextChars?: number }
): Promise<SearchResult & { context: string }> {
  const config = getConfig();
  const contextChars = options?.contextChars || 2000;
  const result = await search(query, options);

  if (!memoryExists()) {
    throw new MemoryNotInitializedError();
  }

  const store = await SearchStore.open(config.memoryPath);
  try {
    const context = result.hits
      .map((hit) => store.textFor(hit.metadata.path, contextChars))
      .filter((text) => text.length > 0)
      .join("\n\n");
    return { ...result, context };
  } finally {
    store.close();
  }
}

/**
 * Quick check if a query has any matches
 */
export async function hasMatches(query: string): Promise<boolean> {
  try {
    const result = await search(query, { limit: 1 });
    return result.hits.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get suggested queries based on indexed content
 */
export async function getSuggestions(
  partialQuery: string,
  _limit = 5
): Promise<string[]> {
  return partialQuery.trim() ? [partialQuery.trim()] : [];
}

function toSearchHit(hit: StoredHit, tokens: string[], snippetChars: number): SearchHit {
  const haystack = hit.text.toLowerCase();
  const matches = tokens.filter((token) => haystack.includes(token.toLowerCase())).length;
  const snippet = cleanSnippet(hit.snippet || hit.text).slice(0, snippetChars);
  return {
    id: hit.path,
    title: hit.title,
    snippet: snippet || "(image)",
    score: hit.score,
    matches,
    tags: hit.tags,
    metadata: {
      path: hit.path,
      timestamp: hit.mtimeMs,
      fileSize: hit.size,
      width: hit.width ?? undefined,
      height: hit.height ?? undefined,
      confidence: hit.confidence ?? undefined,
    },
  };
}

function cleanSnippet(snippet: string): string {
  const lines = snippet.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;
    if (/^[\/+A-Za-z0-9=]{40,}$/.test(trimmed)) continue;
    if (trimmed.startsWith("/9j/") || trimmed.startsWith("iVBOR")) continue;
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmed)) continue;
    return trimmed;
  }
  return snippet.replace(/\s+/g, " ").trim();
}
