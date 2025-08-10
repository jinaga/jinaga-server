# Feeds: Persistent Client Proxy with Waitlist
Author: @michaellperry  
Status: Draft  
Scope: `/feeds/:hash` streaming path (`Accept: application/x-jinaga-feed-stream`)

## Summary

Introduce a per-connection "FeedStreamSession" (client proxy) that:
- Maintains a waitlist of fact references indicated by inverse observers.
- Serializes all fetching and streaming through a single "query cycle" loop driven by the current bookmark.
- Continues initial pagination until exhaustion, then transitions to real-time.
- Emits an explicit "caught up" signal (SYNC) without changing the response schema (empty `references` array + current `bookmark`).

This addresses race conditions between listener callbacks and bookmark mutation, ensures tuple completeness, and guarantees no missed updates when facts arrive between pages.

## Goals

- Deliver all historical feed results before push-only mode.
- Prevent lost updates during the transition to "caught up".
- Maintain tuple completeness ("projection is the tuple; send all facts in tuple").
- Preserve response shape and backwards compatibility.
- Provide predictable lifecycle and resource usage per stream.

## Non-goals

- Changing the `/feeds/:hash` response format.
- Introducing server-sent events or WebSockets (keep current HTTP streaming).
- Redesigning the authorization/feed query pipeline.

---

## Design

### High-level flow

1. On connection, create a `FeedStreamSession` with:
   - `bookmark` (initial from query param `b` or empty),
   - `waitlist` (Set of fact refs by hash/type),
   - `activeCycle` (boolean),
   - `shuttingDown` (boolean),
   - `stream` (Stream<FeedResponse>).

2. Start inverse observers immediately and push matching fact refs into the waitlist.
   - Observers do not fetch/stream themselves.
   - If no cycle is active, they signal to start (or continue) the cycle.

3. Run the query cycle:
   - While true:
     - Call `authorization.feed(user, feed, start, bookmark)`.
     - If tuples returned:
       - Deduplicate facts across tuples in the page.
       - Stream a frame `{ references, bookmark: results.bookmark }`.
       - Remove any queued facts from the waitlist that are included in streamed tuples.
       - Update `bookmark`.
       - Continue.
     - If no tuples returned:
       - If `waitlist` is empty:
         - Stream a SYNC frame with empty `references` and current `bookmark` (backwards compatible).
         - End the cycle.
       - Else:
         - Facts arrived between last page and now. Continue the loop (run feed again) to collect their full tuples.

4. On stream close, remove all observers and mark `shuttingDown` to prevent new cycles.

### Class responsibilities

- FeedStreamSession
  - Owns lifecycle and state for a connection.
  - Public methods:
    - `start()` => sets observers and kicks off initial paginated backfill to exhaustion.
    - `onInverseMatch(factRefs[])` => add to waitlist; `startCycleIfIdle()`.
    - `done()` => unregister observers; cancel cycle on stream close.
  - Private:
    - `runCycle()` => serializes fetch/stream; guarded by `activeCycle`.
    - `streamPage(results)` => compute deduped references and stream with bookmark.
    - `streamSync()` => stream `{ references: [], bookmark }`.
    - `drainWaitlistIfNeeded()` => loop continues until `no tuples && waitlist empty`.

- Router integration (src/http/router.ts)
  - Construct `FeedStreamSession` in the `/feeds/:hash` handler.
  - Replace direct "listener => streamFeedResponse" pattern with session waitlist notifications.

### Waitlist semantics

- Waitlist keyed by `{hash,type}` ensures no duplicates.
- Removal happens only when the tuple containing the fact is streamed (preserves tuple completeness).
- Waitlist is a trigger to keep querying; we do not stream waitlist facts directly.

### SYNC signaling

- Preserve response schema:
  - Emit SYNC as a frame with `references: []` and current `bookmark`.
  - Clients that need an explicit signal can treat empty `references` as "caught up".

### Concurrency and races

- Single-cycle execution: `activeCycle` flag prevents concurrent runs.
- Listener callbacks never mutate `bookmark` and never fetch/stream; they only enqueue refs and wake the cycle.
- Bookmark progresses monotonically within the cycle; no interleaving updates.

### Backpressure and limits

- Add conservative limits (configurable):
  - `maxInitialPages` (default 1000)
  - `maxWaitlistSize` (e.g., 50k refs) -> if exceeded, drop connection with 503 and log.
  - Optional small delay every N pages (e.g., 10ms every 10 pages).
- Consider extending Stream to a "BackpressureStream" in a follow-up to cap buffer length.

### Telemetry

- Per-stream diagnostic log context (feed hash, connection id).
- Metrics:
  - initial pages fetched, total references streamed, cycle count per connection,
  - time to SYNC,
  - waitlist high-water mark,
  - dropped due to limits.

---

## Integration Points

- src/http/router.ts
  - `/feeds/:hash` handler (Accept: `application/x-jinaga-feed-stream`).
  - Replace direct `streamFeed` flow by constructing `FeedStreamSession`.

- Authorization layer
  - `authorization.feed(userIdentity, feed, start, bookmark)` pagination contract.

- Feed definition and inversion
  - `feedCache.getFeed(feedHash)`
  - `invertSpecification(feedDefinition.feed)`
  - `computeTupleSubsetHash` and `computeObjectHash` for filtering listener matches.

- FactManager
  - `addSpecificationListener` / `removeSpecificationListener` for inverse triggers.

- Stream
  - `Stream<FeedResponse>` feeding and lifecycle (done/close).

- Configuration
  - Add server config for page limits, waitlist cap, optional small delays.

---

## Dependencies and Assumptions

- Existing bookmark semantics remain stable and monotonic.
- `authorization.feed` returns `tuples` and `bookmark`, where `tuples.length < pageSize` implies near exhaustion.
- The test client and any existing consumers tolerate empty `references` frames.

---

## Acceptance Criteria

Functional correctness
- Initial backfill:
  - The server streams all historical pages until the feed is exhausted (no tuples left) before transitioning to real-time.
  - Bookmark advances monotonically across frames.
- Real-time updates:
  - Facts arriving during initial pagination are not lost; the session continues querying until their tuples are streamed.
  - Facts arriving after SYNC result in subsequent frames with their tuples, preserving order by bookmark.
- Tuple completeness and deduplication:
  - Each frame's `references` contains the deduplicated set of facts from all tuples in that chunk.
  - Waitlist items are removed only when their containing tuples are streamed.
- SYNC indication:
  - On catching up (no tuples and empty waitlist), server emits a frame with `references: []` and current `bookmark`.
- Lifecycle:
  - On connection close, inverse listeners are unregistered and the cycle stops.
  - No concurrent cycles run per connection.

Performance and robustness
- Backfill eventually completes for large feeds within configured safety limits (e.g., 1000 pages).
- Waitlist does not grow unbounded; if exceeding configured cap, the server closes the stream gracefully with diagnostics.
- Under concurrent connections, memory and CPU remain within acceptable bounds; no deadlocks or starvation.

Security and reliability
- No race conditions update the bookmark concurrently.
- No unbounded buffers in the stream path.
- Listeners are always removed when streams end.

Observability
- Logs/metrics expose: total frames, initial pages, time to SYNC, cycle restarts due to waitlist, waitlist size peaks.

---

## Test Plan

### Unit tests (Jest)

FeedStreamSession
- "Backfill to exhaustion"
  - Given multiple pages returned by `authorization.feed`, verify frames streamed for each page, bookmark progression, and final SYNC frame (empty `references`).
- "Waitlist triggers continuation"
  - With a final page empty, but waitlist non-empty (push facts into waitlist between pages), verify the cycle continues and fetches at least one more page, then SYNCs when waitlist clears.
- "No concurrent cycles"
  - Rapidly enqueue from listener multiple times; assert only one `authorization.feed` loop runs at a time (use mocks and counters).
- "Deduplication"
  - Given overlapping facts across tuples in a page, confirm only unique `{hash,type}` appear in `references`.
- "Tuple completeness"
  - Verify waitlist facts are only removed when their tuples appear in a streamed page.
- "SYNC emission"
  - Assert SYNC frame emitted (empty `references`) exactly when both: last query returned no tuples and waitlist is empty.
- "Bookmark monotonicity"
  - Enforce that sent bookmarks are strictly progressing or stable only for SYNC frames.
- "Listener filtering"
  - Only enqueue facts from inverse results that match `givenSubset` (use `computeTupleSubsetHash` matching).
- "Lifecycle cleanup"
  - On `stream.done()`, verify removal of all listeners and no further cycle runs.
- "Limits"
  - If `waitlist` exceeds cap, session terminates gracefully (mock log) and removes listeners.

Router integration
- "Session wiring"
  - `/feeds/:hash` with stream accept header constructs session, calls `start()`, and proxies `stream.feed` to response writer.

### Integration tests (Jest + supertest or Node http)

- "Complete historical stream"
  - Seed DB with > pageSize tuples (e.g., 350) matching the feed. Connect and assert received multiple frames covering all facts, then SYNC.
- "Race during backfill"
  - Start stream, insert facts while initial pagination runs. Assert no missed updates; frames include these facts by the time SYNC arrives.
- "Post-SYNC updates"
  - After SYNC, insert new facts. Assert subsequent frames deliver them with updated bookmark.
- "Multiple concurrent clients"
  - Spin up N clients (e.g., 20). Assert similar message counts and time-to-sync distribution; no client stalls. Reuse `test-concurrent-streams.js` patterns (or convert to automated test).
- "Disconnect handling"
  - Client disconnect mid-backfill. Assert listeners removed and no residual cycle iterations.
- "Waitlist stress"
  - Burst insert causing many inverse triggers quickly. Validate waitlist remains under cap or stream terminates with diagnostics.
- "Timeout/long feeds"
  - Emulate large dataset to ensure the process respects configured page limits and still reaches SYNC or terminates cleanly.

Telemetry validation
- Expose counters to a test sink; assert metrics present (initial pages, cycles, SYNC count).

---

## Rollout

- Feature flag: `feeds.fullInitialPagination` (default enabled if prior behavior already documented; if not, roll out gradually).
- Config options:
  - `feeds.maxInitialPages` (default 1000)
  - `feeds.waitlistCap` (default 50,000)
  - `feeds.pageDelayEvery` (default 10 pages => 10ms delay)
- Logging: scoped per-connection id and feed hash, with sampling if needed.

---

## Implementation Steps

1. Create `FeedStreamSession` in `src/feeds/FeedStreamSession.ts`.
   - Constructor: dependencies (`authorization`, `factManager`, `feedDefinition`, `userIdentity`, `start`, `stream`, `initialBookmark`, config).
   - Methods: `start()`, `runCycle()`, `onInverseMatch()`, `streamPage()`, `streamSync()`, `dispose()`.

2. Update `/feeds/:hash` handler in `src/http/router.ts`.
   - Where `streamFeed` currently instantiates `Stream<FeedResponse>` and registers listeners, replace with session creation and `start()`.
   - On `stream.done()`, call `session.dispose()`.

3. Move/Reuse helper logic:
   - Deduping facts per page.
   - Inverse computation and given subset filtering.
   - Bookmark management.

4. Add configuration and defaults.

5. Add tests:
   - Unit tests for session (mocks for `authorization`, `factManager`, `stream`).
   - Integration tests using real HTTP and seeded DB.
   - Optionally adapt `test-concurrent-streams.js` into a CI test harness or keep as manual tool.

6. Add telemetry and structured logs.

7. Documentation:
   - Update `documentation/streaming-feeds-full-results-solution.md` to reference the session model and SYNC semantics.
   - Add this design document.

---

## Risks and Mitigations

- Risk: Unbounded memory due to large waitlists or slow clients.
  - Mitigate: Waitlist caps, future backpressure stream implementation, connection duration limits.
- Risk: Deadlock or missed wake-ups.
  - Mitigate: Simple state machine (`activeCycle`, `needsCycle`) and thorough unit tests for concurrency.
- Risk: Client incompatibility with empty `references` frames.
  - Mitigate: Already valid JSON per existing schema; integration tests against existing client.

---

## Open Questions

- Should SYNC frames be optional behind a config gate?
- Do we need a small debounce before emitting SYNC to reduce "thrash" under constant writes?
- Do we need connection-level backpressure limits immediately, or as a follow-up (as per security audit notes)?