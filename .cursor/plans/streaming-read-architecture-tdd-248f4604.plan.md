<!-- 248f4604-ffe0-40d0-a87c-f0818f2860e3 66fc22f3-5a0a-4e8d-8704-bf2ea54c777a -->
# Streaming Read Endpoint - TDD Implementation Plan

## Overview

Implement the streaming architecture described in `docs/design/read-endpoint-streaming-architecture.md` using test-driven development. Each test drives implementation changes, with git commits showing incremental progress.

## Phase 1: Content Negotiation (Array-Based)

### Test Suite Setup

**File**: `integration-test/jinaga-test/read-endpoint.test.js`

Create initial test infrastructure that sets up Express app with HTTP router using real Postgres database.

### 1.1: Test - Default JSON Response (Backward Compatibility)

**Test**: POST /read returns pretty-printed JSON array with default Accept header

- Setup: Create Root and 2 Successors in database
- Request: POST /read with specification
- Assert: Content-Type is text/plain, response is formatted JSON array

**Implementation**: None needed - current code already passes

**Commit**: `test: add e2e test for /read default JSON response`

### 1.2: Test - Compact JSON Response

**Test**: POST /read returns compact JSON when Accept: application/json

- Setup: Same test data
- Request: POST /read with Accept: application/json
- Assert: Content-Type is application/json, response is compact (no whitespace)

**Implementation**: Create `outputReadResults()` function in `src/http/router.ts` (lines 304-320 pattern)

**Refactor**: Replace `postString` wrapper with `post` wrapper for /read endpoint

**Commit**: `feat: add content negotiation for /read endpoint`

### 1.3: Test - Pretty JSON for Debugging

**Test**: POST /read returns pretty JSON when Accept: text/plain

- Assert: 2-space indentation, readable format

**Implementation**: Add text/plain case to `outputReadResults()`

**Commit**: `feat: add text/plain format for /read debugging`

### 1.4: Test - NDJSON Format

**Test**: POST /read returns newline-delimited JSON when Accept: application/x-ndjson

- Setup: 5 successors
- Assert: Content-Type is application/x-ndjson, 5 lines, each line is valid JSON

**Implementation**: Add NDJSON case to `outputReadResults()` using `res.write()` in loop

**Commit**: `feat: add NDJSON format for /read streaming clients`

### 1.5: Test - OPTIONS Endpoint Update

**Test**: OPTIONS /read returns supported content types

- Assert: Accept-Post includes application/json, text/plain, application/x-ndjson

**Implementation**: Update `setOptions()` call for /read (line 377-379)

**Commit**: `feat: update OPTIONS for /read content types`

### 1.6: Test - Large Result Set (1000 items)

**Test**: POST /read handles 1000 results with all formats

- Assert: All formats complete successfully, results count is correct

**Implementation**: No changes needed - validates array-based approach

**Commit**: `test: validate /read with large result sets`

**Git Tag**: `phase-1-content-negotiation`

---

## Phase 2: Streaming Infrastructure

### 2.1: Test - ResultStream Interface

**Test**: Unit test for ResultStream interface with mock data

- Test: next() returns items sequentially
- Test: next() returns null when exhausted
- Test: close() stops iteration

**Implementation**: Create `src/http/result-stream.ts` with:

- `ResultStream<T>` interface
- `AsyncIterableResultStream<T>` class
- `arrayToResultStream()` helper

**Commit**: `feat: add ResultStream abstraction for streaming results`

### 2.2: Test - Array to Stream Conversion

**Test**: arrayToResultStream converts array to working stream

- Setup: Array of 10 items
- Assert: Stream yields all items in order

**Implementation**: Implement `arrayToResultStream()` function

**Commit**: `feat: implement array to ResultStream conversion`

### 2.3: Test - NDJSON Streaming Output

**Test**: E2E test - /read streams NDJSON without loading all into memory

- Setup: 5000 successors in database
- Request: Accept: application/x-ndjson
- Assert: Response starts within 1 second, completes successfully

**Implementation**: Create `src/http/output-formatters.ts`:

- `outputReadResultsStreaming()` function
- `streamAsNDJSON()` async function
- `collectAndSendJSON()` fallback

**Commit**: `feat: implement streaming NDJSON output formatter`

### 2.4: Test - Stream Error Handling

**Test**: Stream handles errors mid-transmission

- Setup: Mock stream that throws after 3 items
- Assert: Error sent as NDJSON line with error:true

**Implementation**: Add try/catch to `streamAsNDJSON()` with error frame

**Commit**: `feat: add error handling for streaming responses`

### 2.5: Test - Backward Compatibility with Arrays

**Test**: Streaming formatter accepts array input

- Setup: Pass array to `outputReadResultsStreaming()`
- Assert: Converts to stream and outputs correctly

**Implementation**: Add array check in `outputReadResultsStreaming()`

**Commit**: `feat: support array fallback in streaming output`

### 2.6: Refactor - Update Router to Use Streaming Output

**Test**: All existing /read tests still pass

**Refactor**:

- Update /read route to use `outputReadResultsStreaming()`
- Keep array-based `read()` method unchanged

**Commit**: `refactor: migrate /read to streaming output formatter`

### 2.7: Test - CSV Output Format (Bonus)

**Test**: POST /read returns CSV when Accept: text/csv

- Setup: Structured data with consistent fields
- Assert: Valid CSV with headers, proper escaping

**Implementation**: Add `streamAsCSV()` function using existing csv-stringify dependency

**Commit**: `feat: add CSV output format for /read`

**Git Tag**: `phase-2-streaming-infrastructure`

---

## Phase 3: Data Layer Optimization

### 3.1: Test - Authorization readStream Method

**Test**: Unit test for authorization.readStream() returning AsyncIterable

- Setup: Mock postgres with cursor-based results
- Assert: Yields results incrementally without loading all

**Implementation**: Add `readStream()` method to Authorization interface in jinaga package

**Note**: This requires coordination with jinaga core team

**Commit**: `feat: add readStream method to Authorization interface`

### 3.2: Test - PostgresStore Cursor Implementation

**Test**: PostgresStore yields results using database cursor

- Setup: 10000 rows in database
- Assert: Memory usage stays under 50MB during iteration

**Implementation**:

- Add `readStream()` to `src/postgres/postgres-store.ts`
- Use `pg` cursor or streaming query
- Yield `ProjectedResult` objects incrementally

**Commit**: `feat: implement cursor-based readStream in PostgresStore`

### 3.3: Test - Memory Usage Verification

**Test**: E2E test measuring actual memory usage

- Setup: 50000 successors
- Request: Accept: application/x-ndjson
- Assert: Heap increase < 100MB (vs ~500MB for array)

**Implementation**: No changes - validates streaming works

**Commit**: `test: verify constant memory usage with streaming`

### 3.4: Test - readWithStreaming Method

**Test**: HttpRouter.readWithStreaming() uses readStream when available

- Setup: Mock authorization with readStream
- Assert: Calls readStream, not read

**Implementation**: Create `readWithStreaming()` method in `src/http/router.ts`:

- Check if `authorization.readStream` exists
- Call readStream and wrap in AsyncIterableResultStream
- Fallback to array-based read()

**Commit**: `feat: implement readWithStreaming with data layer streaming`

### 3.5: Test - Streaming with Authorization

**Test**: E2E test - streaming respects authorization rules

- Setup: User with limited access, mixed authorized/unauthorized data
- Assert: Only authorized results streamed

**Implementation**: Ensure readStream applies authorization filters

**Commit**: `test: verify authorization with streaming queries`

### 3.6: Test - Concurrent Stream Handling

**Test**: Multiple concurrent /read streams don't interfere

- Setup: 5 simultaneous requests with NDJSON
- Assert: All complete correctly, no memory leak

**Implementation**: Ensure proper resource cleanup in streams

**Commit**: `test: validate concurrent streaming requests`

### 3.7: Test - Stream Cancellation

**Test**: Client disconnect closes database cursor

- Setup: Start streaming, simulate disconnect after 100 items
- Assert: Database cursor closed, resources released

**Implementation**: Add cleanup handlers to ResultStream

**Commit**: `feat: implement stream cleanup on client disconnect`

### 3.8: Refactor - Consolidate Stream Handling

**Test**: All /read tests pass with streaming enabled

**Refactor**:

- Update /read route to prefer streaming when available
- Extract common streaming patterns
- Add JSDoc comments

**Commit**: `refactor: consolidate streaming architecture`

### 3.9: Test - Performance Benchmarks

**Test**: Benchmark suite comparing array vs streaming

- Test 1000, 10000, 50000 results
- Measure: Time to first byte, total time, memory usage

**Implementation**: Add performance test file

**Commit**: `test: add performance benchmarks for streaming`

### 3.10: Documentation

**Update**: Architecture document with implementation notes

**Update**: README with new Accept header options

**Commit**: `docs: document streaming /read implementation`

**Git Tag**: `phase-3-data-layer-streaming`

---

## Testing Strategy

### Test File Structure

```
integration-test/jinaga-test/
  ├── read-endpoint.test.js          # E2E tests for /read
  ├── read-streaming.test.js         # Streaming-specific tests
  ├── read-performance.test.js       # Performance benchmarks
  └── http-test-helpers.js           # Shared utilities
```

### Test Helpers

- `createTestApp()` - Sets up Express with HTTP router and Postgres
- `createTestData(count)` - Generates test facts efficiently
- `parseNDJSON(text)` - Splits and parses NDJSON response
- `measureMemory(fn)` - Wraps test to measure heap usage

### Git Workflow

- Each test gets its own commit when written (failing)
- Implementation commit makes the test pass
- Refactoring gets separate commits
- Tags mark phase completions

### CI/CD Integration

- Run integration tests in Docker with Postgres
- Add memory usage assertions to catch regressions
- Performance tests run nightly (not blocking)

## Key Architectural Principles

1. **Test First**: Write failing test before implementation
2. **One Test at a Time**: Don't move to next test until current passes
3. **Refactor Safely**: All tests passing before refactoring
4. **Incremental Commits**: Small, focused commits with clear messages
5. **Backward Compatible**: Existing clients continue working throughout
6. **Resource Safety**: Proper cleanup of streams and database connections

### To-dos

- [ ] Create read-endpoint.test.js with test infrastructure and Express app setup
- [ ] Write test for default JSON response (backward compatibility)
- [ ] Write test for compact JSON with Accept: application/json
- [ ] Create outputReadResults() function with content negotiation
- [ ] Replace postString with post wrapper for /read endpoint
- [ ] Write test for pretty JSON with Accept: text/plain
- [ ] Write test for NDJSON format with Accept: application/x-ndjson
- [ ] Implement NDJSON output in outputReadResults()
- [ ] Write test for OPTIONS /read endpoint
- [ ] Update setOptions() call for /read with new content types
- [ ] Write test for 1000+ result set with all formats
- [ ] Create git tag phase-1-content-negotiation
- [ ] Write unit tests for ResultStream interface
- [ ] Implement ResultStream interface and AsyncIterableResultStream class
- [ ] Write test for arrayToResultStream() conversion
- [ ] Implement arrayToResultStream() helper function
- [ ] Write E2E test for streaming NDJSON with 5000 items
- [ ] Create output-formatters.ts with streaming functions
- [ ] Write test for error handling during streaming
- [ ] Add error handling to streamAsNDJSON()
- [ ] Write test for array input to streaming formatter
- [ ] Add array detection and conversion in streaming output
- [ ] Update /read route to use outputReadResultsStreaming()
- [ ] Write test for CSV output format
- [ ] Implement streamAsCSV() function
- [ ] Create git tag phase-2-streaming-infrastructure
- [ ] Write unit test for authorization.readStream() method
- [ ] Add readStream() to Authorization interface
- [ ] Write test for PostgresStore cursor implementation
- [ ] Implement cursor-based readStream in PostgresStore
- [ ] Write E2E test measuring memory usage with 50k items
- [ ] Write test for readWithStreaming() method
- [ ] Implement readWithStreaming() in HttpRouter
- [ ] Write test for authorization with streaming
- [ ] Write test for concurrent streaming requests
- [ ] Write test for stream cleanup on client disconnect
- [ ] Implement cleanup handlers in ResultStream
- [ ] Consolidate streaming patterns and add documentation
- [ ] Create performance benchmark suite
- [ ] Update architecture docs and README
- [ ] Create git tag phase-3-data-layer-streaming