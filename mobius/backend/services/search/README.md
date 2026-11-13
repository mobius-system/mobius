# Indexed session search

Search lives in this directory. The HTTP mount in `server.js` points directly to
`router.ts`; there is no file-scanning search route or old SSE search protocol.

- `content.ts`: ICU Chinese word segmentation, query validation, native message
  extraction, injected-context removal and precise snippet validation.
- `index.ts`: contentless FTS5 index and transactional incremental indexing inside
  the existing `agent-history-store.db`. Original message JSON is not duplicated.
- `worker.ts`: background history ingestion/indexing and isolated read execution.
- `service.ts`: bounded query queue, cancellation and worker lifecycle.
- `router.ts`: Mobius-only source inventory, readable scope, request validation
  and final permission revalidation.

The index stores unique hex-encoded normalized word tokens, not message bodies,
word positions or a second search database. Chinese segmentation uses Node's ICU
`Intl.Segmenter`; FTS5 performs intersection. All space-separated query terms must
also occur literally in the same extracted message. This is word search, not
arbitrary substring, typo correction, quoted phrase or semantic search.

Both entry writes and index updates are transactional. Insert/update triggers
queue changed rowids; delete triggers remove postings immediately. Initial indexing
advances a persistent rowid checkpoint in batches of 10 without a fixed 200ms wait. Tokenization
runs before the short index-write transaction; changed rows are revalidated inside
that transaction. The indexer checks up to 20 source signatures and ingests at most
one changed source every second. It does
not search files on behalf of an HTTP request. Sessions with pending round openers
are left to their owning runtime to ingest, to avoid changing live turn grouping.

Only undeleted Mobius sessions enter the inventory. Query scope is computed from
current permissions before retrieval and rechecked before response delivery. Index
progress and unavailable histories are reported separately. There is no scan
fallback when an index is incomplete, the worker fails or a query times out.

Prerequisites: SQLite with FTS5 contentless-delete support (3.43+) and Node with
full ICU. Unsupported deployments fail explicitly, rather than silently scanning.
The existing `better-sqlite3` dependency provides SQLite; no new dependency or
external search service is installed.

Background ingestion and indexing use a cooperative budget of 35% of available
machine CPU capacity (CPU affinity and cgroup v2 ancestor quotas are considered).
Each cycle measures process CPU time and rests only after all transactions close.
There is no SIGSTOP monitor or deliberate sleeping while holding database locks.
The budget is a sustained average, not an instantaneous kernel quota. A single
indexing thread normally uses at most one core; 35% does not request extra threads.
CPU metrics report a percentage of the available machine, not of one core.
Background connections never queue for the history database write lock
(`busy_timeout=0`); contention leaves progress intact and retries on a later cycle.
Index batches stop adding rows after a 5ms write budget and yield for at least
25ms outside all transactions. One SQLite statement/commit can exceed that budget;
this is cooperative foreground protection, not a hard realtime priority guarantee.
SHA-256 fingerprints skip unchanged entries encountered by both backfill and the
pending queue. Fingerprints cost approximately 64 bytes plus SQLite overhead per
entry and never duplicate message bodies. Image blocks and inline image data URLs
are excluded; textual captions remain searchable. Existing postings are not
automatically rebuilt, to avoid restarting the ongoing backfill.
Ten-second CPU/read/tokenize/write counters are in history_search_metrics and
printed by scripts/trace-search-progress.py (run from the repository root).

Validation:

```sh
npm run test:indexed-search
npm run test:indexed-search-worker
node frontend/tests/search-view-session.test.mjs
```
