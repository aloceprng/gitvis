/**
 * api/client.ts
 *
 * Fetch wrapper and AsyncGenerator streaming parsers for the git visualizer
 * backend at 127.0.0.1:7832.
 *
 * Design notes:
 *   - fetchGraph and postAction return AsyncGenerators so callers can start
 *     rendering before the full response arrives (progressive rendering).
 *   - streamNDJSON is the shared primitive: it reads a ReadableStream,
 *     accumulates chunks, splits on newlines, and JSON.parses each line.
 *   - All functions throw on network errors; callers should catch and surface
 *     these to the UI.
 *   - No authentication — this is a loopback-only server.
 */

import type {
  Row,
  CommitDetail,
  RefsResponse,
  SearchResult,
  ActionRequest,
  ActionEvent,
  WatchEvent,
  GraphParams,
  SearchParams,
} from "./types";

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

const BASE = "http://127.0.0.1:7832";
const WS_BASE = "ws://127.0.0.1:7832";

// ---------------------------------------------------------------------------
// Core streaming primitive
// ---------------------------------------------------------------------------

/**
 * Reads a Response body as an NDJSON stream.
 *
 * Each non-empty line is JSON.parsed and yielded as T. The generator keeps a
 * partial-line buffer so chunk boundaries never cause parse errors — a chunk
 * may end in the middle of a JSON object.
 *
 * @throws {Error} if response.body is null (e.g. in environments without
 *   Streams API support, or on a Response with no body).
 * @throws {SyntaxError} if a complete line cannot be JSON.parsed.
 */
async function* streamNDJSON<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) {
    throw new Error("Response body is null — cannot stream NDJSON");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        buffer += decoder.decode(value, { stream: !done });

        // Split on newlines. Every complete line except the last fragment is
        // ready to parse. The last element is either "" (line ended on \n) or
        // a partial line — keep it as the new buffer.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // retain the trailing fragment

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            yield JSON.parse(trimmed) as T;
          }
        }
      }

      if (done) {
        // Flush any remaining content (response didn't end with \n).
        const trimmed = buffer.trim();
        if (trimmed.length > 0) {
          yield JSON.parse(trimmed) as T;
        }
        break;
      }
    }
  } finally {
    // Always release the reader lock, even if the caller breaks out of the
    // for-await-of loop early (e.g. they only wanted the first N rows).
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Pings the backend. Returns true if the server responds with "pong".
 * Useful for confirming the sidecar process is ready before the first
 * fetchGraph call.
 */
export async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/ping`);
    const text = await res.text();
    return text.trim() === "pong";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Graph — paginated NDJSON stream
// ---------------------------------------------------------------------------

/**
 * Streams commit rows from GET /graph.
 *
 * Yields Row objects progressively as they arrive. The caller can render
 * batches as they come in rather than waiting for the full response.
 *
 * Params:
 *   limit  — max rows to return (default 500, server-side max 5000)
 *   before — SHA cursor for pagination; omit for the first page
 *   filter — branch name to filter by, or "all" (default "all")
 *
 * The response includes an X-Has-More header. Because headers arrive before
 * the body, we expose it via the generator's return value — callers that need
 * it should collect it from fetchGraphWithMeta instead.
 *
 * @throws {Error} on non-2xx status or missing body.
 */
export async function* fetchGraph(params: GraphParams = {}): AsyncGenerator<Row> {
  const url = buildGraphURL(params);
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GET /graph failed: ${res.status} ${res.statusText}`);
  }

  yield* streamNDJSON<Row>(res);
}

/**
 * Like fetchGraph, but also returns the X-Has-More header value so the store
 * knows whether to show a "load more" button / trigger auto-pagination.
 *
 * Returns { rows: AsyncGenerator<Row>, hasMore: Promise<boolean> }.
 *
 * hasMore resolves to true when the server signals more pages are available.
 * Note: the header is available as soon as the response arrives (before body
 * streaming completes), so you can await it independently.
 */
export function fetchGraphWithMeta(params: GraphParams = {}): {
  rows: AsyncGenerator<Row>;
  hasMore: boolean;
  nextCursor: string | null;
} {
  // This is a synchronous factory — the actual fetch happens lazily when the
  // generator is iterated. We need headers first, so we use a different shape
  // here: eagerly fetch and capture headers, then stream the body.
  throw new Error(
    "fetchGraphWithMeta must be called via fetchGraphEager — see implementation below"
  );
}

/**
 * Eagerly fetches /graph (fires the request immediately), captures headers,
 * and returns both the streaming row generator and pagination metadata.
 *
 * This is the preferred function for the graphStore's loadInitial / loadMore:
 *
 *   const { rows, hasMore, nextCursor } = await fetchGraphEager(params);
 *   for await (const row of rows) { store.appendRow(row); }
 *   store.setHasMore(hasMore);
 *   store.setCursor(nextCursor);
 */
export async function fetchGraphEager(params: GraphParams = {}): Promise<{
  rows: AsyncGenerator<Row>;
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const url = buildGraphURL(params);
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GET /graph failed: ${res.status} ${res.statusText}`);
  }

  // X-Has-More is "true" or absent/false.
  const hasMore = res.headers.get("X-Has-More") === "true";

  // The cursor for the next page is the SHA of the last row. The backend
  // accepts a `before` cursor (exclusive). We capture it from the last row
  // yielded — but since this is a stream, the caller should track it.
  // We expose it as null here; the store updates it after streaming completes.
  const nextCursor: string | null = null;

  return {
    rows: streamNDJSON<Row>(res),
    hasMore,
    nextCursor,
  };
}

function buildGraphURL(params: GraphParams): string {
  const { limit, before, filter } = params;
  const q = new URLSearchParams();
  if (limit !== undefined) q.set("limit", String(limit));
  if (before) q.set("before", before);
  if (filter) q.set("filter", filter);
  const qs = q.toString();
  return `${BASE}/graph${qs ? `?${qs}` : ""}`;
}

// ---------------------------------------------------------------------------
// Commit detail
// ---------------------------------------------------------------------------

/**
 * Fetches metadata and diff stats for a single commit.
 *
 * GET /commit/:sha
 *
 * Returns author, committer, timestamp, subject, body, parents, refs, and
 * a diffStats summary (+N −N in F files). The server resolves short SHAs.
 *
 * @throws {Error} on non-2xx (including 404 for unknown SHA).
 */
export async function fetchCommit(sha: string): Promise<CommitDetail> {
  if (!sha) throw new Error("fetchCommit: sha is required");

  const res = await fetch(`${BASE}/commit/${encodeURIComponent(sha)}`);

  if (!res.ok) {
    throw new Error(
      `GET /commit/${sha} failed: ${res.status} ${res.statusText}`
    );
  }

  return res.json() as Promise<CommitDetail>;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/**
 * Fetches all known refs (branches, tags, remotes) plus in-progress operation
 * state (merge, rebase, cherry-pick, etc.).
 *
 * GET /refs
 *
 * This is re-fetched whenever the watcher fires a `refs_changed` WatchEvent,
 * so ref labels stay accurate without a full graph reload.
 *
 * @throws {Error} on non-2xx.
 */
export async function fetchRefs(): Promise<RefsResponse> {
  const res = await fetch(`${BASE}/refs`);

  if (!res.ok) {
    throw new Error(`GET /refs failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<RefsResponse>;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Performs a corpus search over commit history (trigram / fuzzy index in Go).
 *
 * GET /search?q=<query>&type=<type>&limit=<limit>
 *
 * Returns 503 while the search index is still building (phase 2 not done).
 * Callers should surface this gracefully ("indexing…") rather than throwing.
 *
 * This is distinct from the command palette's Fuse.js search over ~200
 * command names, which is entirely client-side. fetchSearch is for searching
 * commit messages, authors, and branch names across the full git history.
 *
 * @throws {Error} on network failure or non-2xx (other than 503, which is
 *   returned as { indexing: true } for ergonomic handling).
 */
export async function fetchSearch(
  params: SearchParams
): Promise<SearchResult[] | { indexing: true }> {
  const { q, type, limit } = params;
  if (!q) return [];

  const qs = new URLSearchParams({ q });
  if (type) qs.set("type", type);
  if (limit !== undefined) qs.set("limit", String(limit));

  const res = await fetch(`${BASE}/search?${qs}`);

  if (res.status === 503) {
    return { indexing: true };
  }

  if (!res.ok) {
    throw new Error(`GET /search failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<SearchResult[]>;
}

// ---------------------------------------------------------------------------
// Actions — POST /action with streaming NDJSON response
// ---------------------------------------------------------------------------

/**
 * Executes a git action (checkout, merge, rebase, etc.) and streams progress
 * events back to the caller.
 *
 * POST /action
 * Body: { action, args, confirm }
 * Response: NDJSON stream of ActionEvent objects.
 *
 * Event types:
 *   { type: "stdout", data: string }         — progress output
 *   { type: "stderr", data: string }         — warning / verbose output
 *   { type: "conflict", data: "", files: [] } — merge conflict detected
 *   { type: "done", data: "" }               — success
 *   { type: "error", data: string }          — failure message
 *
 * Destructive actions (reset_hard, branch_delete, tag_delete) require
 * confirm: true — the server rejects without it (409). The caller (command
 * palette) is responsible for showing a confirmation prompt and setting this.
 *
 * @throws {Error} on network failure, 4xx (pre-stream errors like 409
 *   Conflict / in-progress guard), or JSON parse failures mid-stream.
 */
export async function* postAction(
  req: ActionRequest
): AsyncGenerator<ActionEvent> {
  const res = await fetch(`${BASE}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  // 4xx errors are returned before any body is written (the server checks
  // guards before setting headers). Surface them immediately.
  if (!res.ok) {
    let message = `POST /action failed: ${res.status} ${res.statusText}`;
    try {
      // The server may include a JSON error body.
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // No JSON body — use the status message.
    }
    throw new Error(message);
  }

  yield* streamNDJSON<ActionEvent>(res);
}

/**
 * Convenience wrapper: collects all ActionEvents from an action into an array.
 *
 * Useful for fire-and-forget actions where streaming UI feedback isn't needed,
 * or for testing.
 *
 * Resolves with the full event list after the action completes. Rejects on
 * any error event or if the stream throws.
 */
export async function runAction(req: ActionRequest): Promise<ActionEvent[]> {
  const events: ActionEvent[] = [];
  for await (const event of postAction(req)) {
    events.push(event);
    if (event.type === "error") {
      throw new Error(event.data);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// WebSocket — /watch
// ---------------------------------------------------------------------------

/**
 * Options for createWatchSocket.
 */
export interface WatchSocketOptions {
  /** Called for each parsed WatchEvent received from the server. */
  onEvent: (event: WatchEvent) => void;
  /** Called when the WebSocket closes (clean or error). Use to schedule reconnect. */
  onClose: (event: CloseEvent) => void;
  /** Called when the WebSocket opens (useful for resetting backoff counters). */
  onOpen?: () => void;
  /** Called on WebSocket error events. */
  onError?: (event: Event) => void;
}

/**
 * Opens a WebSocket connection to /watch and dispatches WatchEvents.
 *
 * The server pushes two event types:
 *   - graph_updated: new commits pushed or removed (addedShas, removedShas,
 *     movedRefs)
 *   - refs_changed: ref labels moved without new commits (re-fetch /refs)
 *
 * Returns a cleanup function — call it to close the socket deliberately
 * (won't trigger the onClose reconnect logic if you guard on CloseEvent.wasClean).
 *
 * Reconnect with exponential backoff should be implemented in useWebSocket.ts.
 * This function is intentionally stateless: it opens one socket and calls
 * onClose when it's gone. The hook owns reconnect policy.
 *
 * Example usage in useWebSocket:
 *   const cleanup = createWatchSocket({
 *     onEvent: dispatch,
 *     onClose: scheduleReconnect,
 *   });
 *   return cleanup; // call on component unmount
 */
export function createWatchSocket(options: WatchSocketOptions): () => void {
  const { onEvent, onClose, onOpen, onError } = options;

  const ws = new WebSocket(`${WS_BASE}/watch`);

  ws.onopen = () => {
    onOpen?.();
  };

  ws.onmessage = (msgEvent: MessageEvent) => {
    try {
      const event = JSON.parse(msgEvent.data as string) as WatchEvent;
      onEvent(event);
    } catch (err) {
      console.error("[watch] Failed to parse WatchEvent:", err, msgEvent.data);
    }
  };

  ws.onerror = (event: Event) => {
    onError?.(event);
  };

  ws.onclose = (event: CloseEvent) => {
    onClose(event);
  };

  // Return a cleanup function. Callers should call this on unmount.
  return () => {
    // Use code 1000 (Normal Closure) so the server knows this is intentional.
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, "client unmount");
    }
  };
}

// ---------------------------------------------------------------------------
// Utility: collect new commits by SHA for WS-pushed prepend
// ---------------------------------------------------------------------------

/**
 * Fetches specific commits by SHA for prepending to the graph after a
 * graph_updated WebSocket event.
 *
 * The server doesn't have a bulk-by-SHA endpoint; we fetch each individually
 * from /commit/:sha and return the Row-shaped subset needed for the graph.
 * For most pushes this is 1–5 commits, so N sequential fetches is fine.
 *
 * Returns commits in the same order as `shas` (newest first, as the server
 * emits them in addedShas).
 *
 * @throws {Error} if any individual commit fetch fails.
 */
export async function fetchCommitsByShAs(
  shas: string[]
): Promise<CommitDetail[]> {
  // Sequential fetch preserves order and avoids stampeding the loopback server.
  const results: CommitDetail[] = [];
  for (const sha of shas) {
    results.push(await fetchCommit(sha));
  }
  return results;
}