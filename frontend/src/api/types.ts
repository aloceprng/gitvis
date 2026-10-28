/**
 * api/types.ts
 *
 * All shared TypeScript types for the keyboard-first git visualizer.
 *
 * These mirror the wire format exactly — field names match what the Go backend
 * JSON-marshals. Do not rename fields without updating the backend handlers.
 */

// ---------------------------------------------------------------------------
// Graph / row types (GET /graph NDJSON)
// ---------------------------------------------------------------------------

/** Edge types from the backend (graph/model.go EdgeType iota). */
export const EdgeType = {
  Straight: 0,
  MergeIn: 1,
  BranchOut: 2,
} as const;
export type EdgeType = (typeof EdgeType)[keyof typeof EdgeType];

/** One directed edge in the commit graph. */
export interface Edge {
  fromLane: number;
  toLane: number;
  toRow: number;
  type: EdgeType;
}

/** Git author or committer identity. */
export interface GitPerson {
  name: string;
  email: string;
}

/**
 * One row in the graph NDJSON stream.
 *
 * `lane` and `row` are logical coordinates (0-based). The frontend converts
 * to pixels via laneToX / rowToY in utils/canvas.ts.
 *
 * `passthrough` is a uint64 bitmask of active lanes not involved in this row.
 * Safe to handle as a JS number for up to 53 lanes (Number.MAX_SAFE_INTEGER).
 *
 * `activeLanes` is the total lane count at this row — drives canvas width.
 */
export interface Row {
  sha: string;       // full 40-char SHA
  short: string;     // 7-char short SHA
  subject: string;
  author: GitPerson;
  timestamp: string; // ISO 8601
  parents: string[]; // full SHAs
  lane: number;
  row: number;
  edges: Edge[];
  passthrough: number; // uint64 bitmask (safe up to 53 lanes)
  refs: string[];      // e.g. ["refs/heads/main", "HEAD"]
  activeLanes: number;
}

// ---------------------------------------------------------------------------
// Commit detail (GET /commit/:sha)
// ---------------------------------------------------------------------------

/** +N −N in F files summary from commit.Stats(). */
export interface DiffStats {
  additions: number;
  deletions: number;
  files: number;
}

/**
 * Full commit metadata returned by GET /commit/:sha.
 *
 * Subject and body are split on the first blank line. Body may be empty.
 * diffStats is non-fatal — may be absent if Stats() failed (large repos,
 * binary files).
 */
export interface CommitDetail {
  sha: string;
  short: string;
  subject: string;
  body: string;
  author: GitPerson;
  committer: GitPerson;
  timestamp: string;   // author timestamp, ISO 8601
  committedAt: string; // committer timestamp, ISO 8601
  parents: string[];
  refs: string[];
  diffStats?: DiffStats;
}

// ---------------------------------------------------------------------------
// Refs (GET /refs)
// ---------------------------------------------------------------------------

/** One entry in the ref index. */
export interface RefEntry {
  ref: string;  // full ref name, e.g. "refs/heads/main"
  sha: string;
}

/** In-progress git operation types. Empty string = clean state. */
export type InProgressOperation =
  | ""
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | "bisect";

/** Structured metadata for the current in-progress operation. */
export interface InProgressMeta {
  /** For rebase: current step number (1-based). */
  step?: number;
  /** For rebase: total number of steps. */
  total?: number;
  /** For cherry-pick / merge: SHA being applied. */
  sha?: string;
}

/** Full response from GET /refs. */
export interface RefsResponse {
  /** Map of ref name → SHA for all refs (heads, remotes, tags, stash). */
  refs: Record<string, string>;
  /** The currently checked-out branch name, or empty if detached HEAD. */
  head: string;
  /** SHA that HEAD points to (always present). */
  headSha: string;
  /** Active in-progress operation, or "" for clean. */
  inProgress: InProgressOperation;
  /** Structured metadata for the in-progress operation (if any). */
  inProgressMeta?: InProgressMeta;
}

// ---------------------------------------------------------------------------
// Search (GET /search)
// ---------------------------------------------------------------------------

export type SearchResultType = "commit" | "branch" | "tag" | "author";

export interface SearchResult {
  type: SearchResultType;
  sha: string;
  short: string;
  subject: string;
  author: GitPerson;
  timestamp: string;
  refs: string[];
  /** Relevance score from the trigram/fuzzy index (higher = better). */
  score: number;
}

export interface SearchParams {
  q: string;
  type?: SearchResultType;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Actions (POST /action)
// ---------------------------------------------------------------------------

/** All supported git operations. */
export type ActionName =
  | "checkout"
  | "branch_create"
  | "branch_delete"
  | "branch_rename"
  | "merge"
  | "rebase"
  | "rebase_abort"
  | "rebase_continue"
  | "revert"
  | "cherry_pick"
  | "cherry_pick_abort"
  | "reset_soft"
  | "reset_mixed"
  | "reset_hard"
  | "stash"
  | "stash_pop"
  | "stash_drop"
  | "tag"
  | "fetch";

/** Body for POST /action. */
export interface ActionRequest {
  action: ActionName;
  /** Key-value arguments specific to the action. */
  args: Record<string, string>;
  /**
   * Must be true for destructive actions (reset_hard, branch_delete,
   * tag_delete). The server returns 409 without it.
   */
  confirm?: boolean;
}

/** Event types streamed back from POST /action. */
export type ActionEventType = "stdout" | "stderr" | "conflict" | "done" | "error";

export interface ActionEvent {
  type: ActionEventType;
  data: string;
  /** Populated only when type === "conflict". List of conflicted file paths. */
  files?: string[];
}

// ---------------------------------------------------------------------------
// WebSocket watch events (/watch)
// ---------------------------------------------------------------------------

export type WatchEventType = "graph_updated" | "refs_changed";

export interface MovedRef {
  ref: string;  // e.g. "refs/heads/main"
  from: string; // previous SHA
  to: string;   // new SHA
}

/**
 * Event pushed by the server when the repo changes.
 *
 * graph_updated: new commits pushed or removed.
 *   - addedShas: prepend to graph (fetch each via /commit/:sha)
 *   - removedShas: remove from graph (force-push rewrite)
 *   - movedRefs: patch ref labels without a full reload
 *
 * refs_changed: ref labels moved without new commits.
 *   - Re-fetch /refs and call graphStore.updateMovedRefs.
 */
export interface WatchEvent {
  type: WatchEventType;
  addedShas: string[];
  removedShas: string[];
  movedRefs: MovedRef[];
  inProgress: InProgressOperation;
}

// ---------------------------------------------------------------------------
// Graph fetch parameters
// ---------------------------------------------------------------------------

export interface GraphParams {
  /** Max rows to return. Default 500, server-side max 5000. */
  limit?: number;
  /** SHA cursor for pagination (exclusive — returns rows before this SHA). */
  before?: string;
  /** Branch name to filter by, or "all". Default "all". */
  filter?: string;
}