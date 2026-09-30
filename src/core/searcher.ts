/**
 * Search module for screenshot-memory
 * Provides semantic and hybrid search capabilities
 */

import { getMemory, memoryExists } from "./memory.js";
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

  // Check if memory exists
  if (!memoryExists()) {
    throw new MemoryNotInitializedError();
  }

  // Validate query
  if (!query || query.trim().length === 0) {
    throw new SearchError("Search query cannot be empty");
  }

  const searchOptions = {
    mode: options?.mode || config.search.defaultMode,
    limit: options?.limit || config.search.defaultLimit,
    minRelevancy: options?.minRelevancy || config.search.minRelevancy,
    snippetChars: options?.snippetChars || config.search.snippetChars,
    adaptive: options?.adaptive ?? true,
    adaptiveStrategy: options?.adaptiveStrategy || "cliff",
  };

  logger.debug(`Searching for "${query}" with mode: ${searchOptions.mode}`);

  try {
    const mv = await getMemory();

    // Suppress noisy system messages during search
    const originalConsoleError = console.error;
    const originalStderr = process.stderr.write.bind(process.stderr);

    const suppressNoise = (msg: string) =>
      msg.includes("Context leak") || msg.includes("msgtracer");

    console.error = (...args: unknown[]) => {
      if (suppressNoise(String(args[0] || ""))) return;
      originalConsoleError.apply(console, args);
    };
    process.stderr.write = ((chunk: any, ...args: any[]) => {
      if (suppressNoise(String(chunk))) return true;
      return originalStderr(chunk, ...args);
    }) as any;

    // Perform search
    const useEmbeddings = searchOptions.mode === "sem" || searchOptions.mode === "auto";
    const result = await mv.find(query, {
      mode: searchOptions.mode,
      k: searchOptions.limit * 3, // Request more for filtering/deduplication
      snippetChars: searchOptions.snippetChars,
      adaptive: searchOptions.adaptive,
      minRelevancy: searchOptions.minRelevancy,
      adaptiveStrategy: searchOptions.adaptiveStrategy as any,
      ...(useEmbeddings ? { embedder: getLocalEmbedder() } : {}),
    });

    // Restore console/stderr
    console.error = originalConsoleError;
    process.stderr.write = originalStderr;

    // Debug: log raw memvid response
    logger.debug(`Memvid raw result: ${JSON.stringify(result, null, 2)}`);

    // Track seen paths for deduplication
    const seenPaths = new Set<string>();

    // Transform and deduplicate results
    const hits: SearchHit[] = (result.hits || [])
      .map((hit: any) => {
        logger.debug(`Hit raw: score=${hit.score}, relevancy=${hit.relevancy}, bm25=${hit.bm25_score}`);

        // Extract metadata - memvid embeds it in snippet or has it at top level
        const extractMetadata = (text: string, key: string): string | undefined => {
          const regex = new RegExp(`${key}:\\s*([^\\n]+)`);
          const match = text.match(regex);
          return match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
        };

        const snippetText = hit.snippet || hit.text || "";
        const path = extractMetadata(snippetText, "path") || hit.metadata?.path || "";
        const timestamp = hit.created_at
          ? new Date(hit.created_at).getTime()
          : (parseFloat(extractMetadata(snippetText, "timestamp") || "0") || hit.metadata?.timestamp || 0);
        const width = parseInt(extractMetadata(snippetText, "width") || "0") || hit.metadata?.width;
        const height = parseInt(extractMetadata(snippetText, "height") || "0") || hit.metadata?.height;
        const confidence = parseFloat(extractMetadata(snippetText, "confidence") || "0") || hit.metadata?.confidence;

        // Clean snippet - prefer AI description over OCR garbage or binary
        let cleanSnippet = "";

        // Try to extract AI description first (format: [Image: description] or [Image description: ...])
        const descMatch = snippetText.match(/\[Image(?:\s+description)?:\s*([^\]]+)\]/i);
        if (descMatch) {
          cleanSnippet = descMatch[1].trim();
        } else {
          // Look for readable text, skip binary/base64
          const lines = snippetText.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            // Skip empty or very short lines
            if (!trimmed || trimmed.length < 5) continue;

            // Skip base64 patterns (more comprehensive)
            if (/^[\/\+A-Za-z0-9=]{40,}$/.test(trimmed)) continue;
            if (/[\/\+A-Za-z0-9=]{100,}/.test(trimmed)) continue; // base64 anywhere in line

            // Skip common base64 prefixes
            if (trimmed.startsWith('/9j/')) continue; // JPEG base64
            if (trimmed.startsWith('iVBOR')) continue; // PNG base64
            if (trimmed.startsWith('R0lGOD')) continue; // GIF base64
            if (trimmed.startsWith('UklGR')) continue; // WebP base64

            // Skip binary/control characters
            if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmed)) continue;

            // Skip lines that look like encoded data (high ratio of special chars)
            const specialRatio = (trimmed.match(/[\/\+\=]/g) || []).length / trimmed.length;
            if (specialRatio > 0.1 && trimmed.length > 50) continue;

            cleanSnippet = trimmed;
            break;
          }

          // Fallback
          if (!cleanSnippet) {
            cleanSnippet = "(image)";
          }
        }

        const score = hit.score || hit.relevancy || hit.bm25_score || 0;

        return {
          id: hit.uri || hit.id || hit.frameId || "",
          title: hit.title || "",
          snippet: cleanSnippet,
          score,
          matches: hit.matches || 0,
          tags: hit.tags || [],
          labels: hit.labels || [],
          metadata: {
            path,
            timestamp,
            fileSize: parseInt(extractMetadata(snippetText, "fileSize") || "0") || hit.metadata?.fileSize,
            width,
            height,
            confidence,
          },
        };
      })
      // Deduplicate by path - keep highest scoring version
      .filter((hit: SearchHit) => {
        if (!hit.metadata.path) return true;
        if (seenPaths.has(hit.metadata.path)) return false;
        seenPaths.add(hit.metadata.path);
        return true;
      })
      // Sort by score descending, then by match count as tiebreaker
      .sort((a: SearchHit, b: SearchHit) => {
        const scoreDiff = b.score - a.score;
        if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
        // Use match count as tiebreaker
        return (b.matches || 0) - (a.matches || 0);
      });

    // Only show results with meaningful matches
    // If top result has many matches, filter out those with significantly fewer
    const topMatches = hits[0]?.matches || 0;
    const relevantHits = topMatches > 5
      ? hits.filter((hit: SearchHit) => (hit.matches || 0) >= topMatches * 0.6)
      : hits;

    // Limit results
    const finalHits = relevantHits.slice(0, searchOptions.limit);

    return {
      query,
      mode: searchOptions.mode as SearchMode,
      hits: finalHits,
      totalHits: result.total_hits || finalHits.length,
      tookMs: Date.now() - startTime,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Handle specific memvid errors
    if (message.includes("MV004")) {
      throw new SearchError(
        "Lexical index not enabled. Re-index to enable search.",
        "Run 'ssm index --force' to rebuild the index."
      );
    }

    if (message.includes("MV011")) {
      throw new SearchError(
        "Vector index not enabled. Re-index to enable semantic search.",
        "Run 'ssm index --force' to rebuild the index."
      );
    }

    throw new SearchError(`Search failed: ${message}`);
  }
}

/**
 * Search with RAG-style context (for future AI integration)
 */
export async function searchWithContext(
  query: string,
  options?: SearchOptions & { contextChars?: number }
): Promise<SearchResult & { context: string }> {
  const config = getConfig();

  if (!memoryExists()) {
    throw new MemoryNotInitializedError();
  }

  const searchOptions = {
    mode: options?.mode || config.search.defaultMode,
    limit: options?.limit || 10,
    snippetChars: options?.snippetChars || 500,
    contextChars: options?.contextChars || 2000,
  };

  try {
    const mv = await getMemory();

    const result = await mv.ask(query, {
      mode: searchOptions.mode,
      k: searchOptions.limit,
      snippetChars: searchOptions.snippetChars,
      contextOnly: true,
      returnSources: true,
    } as any);

    // Build context string
    const context = (result as any).context ||
      (result as any).hits?.map((h: any) => h.snippet).join("\n\n") || "";

    // Transform to SearchResult format
    const hits: SearchHit[] = ((result as any).hits || []).map((hit: any) => ({
      id: hit.id || "",
      title: hit.title || "",
      snippet: hit.snippet || "",
      score: hit.score || 0,
      metadata: {
        path: hit.metadata?.path || "",
        timestamp: hit.metadata?.timestamp || 0,
      },
    }));

    return {
      query,
      mode: searchOptions.mode as SearchMode,
      hits,
      totalHits: hits.length,
      tookMs: (result as any).took_ms || 0,
      context,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SearchError(`Context search failed: ${message}`);
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
  // This would require a more sophisticated implementation
  // For now, just return the query itself
  return partialQuery.trim() ? [partialQuery.trim()] : [];
}
