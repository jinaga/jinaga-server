# /read Endpoint Streaming Architecture Design

## Executive Summary

This document provides architectural recommendations for refactoring the `/read` endpoint to support:
1. **Content Negotiation**: Multiple output formats based on Accept headers
2. **Streaming Support**: Incremental data transfer without loading all results into memory
3. **Separation of Concerns**: Decoupled HTTP layer from data handling logic

## Current Architecture Analysis

### Current Implementation Issues

**Line 355 in router.ts:**
```typescript
router.post('/read', applyAllowOrigin, postString((user, input: string) => this.read(user, input)));
```

**Lines 426-446 (read method):**
```typescript
private read(user: RequestUser | null, input: string): Promise<any[]> {
    // ... parsing and validation ...
    const results = await this.authorization.read(userIdentity, start, specification);
    const extracted = extractResults(results);
    return extracted.result;  // Returns entire result set as array
}
```

**postString wrapper (lines 216-234):**
```typescript
function postString<U>(method: (user: RequestUser, message: string) => Promise<U>): Handler {
    // ... parsing ...
    method(user, input)
        .then(response => {
            res.type("text");  // Hardcoded content type
            res.send(JSON.stringify(response, null, 2));  // Always JSON
            next();
        })
    // ...
}
```

### Problems Identified

1. **No Content Negotiation**: Always returns JSON regardless of Accept header
2. **Memory Pressure**: All results loaded into array before sending
3. **Tight Coupling**: HTTP formatting logic embedded in wrapper function
4. **No Streaming**: Cannot incrementally send results as they're produced
5. **Inconsistent Pattern**: `/load` endpoint supports content negotiation, `/read` doesn't

## Architectural Recommendations

### Solution Overview

Adopt a layered architecture similar to the existing `/load` and `/feeds/:hash` endpoints:

```
┌─────────────────────────────────────────────────┐
│           HTTP Layer (router.ts)                │
│  - Content negotiation                          │
│  - Accept header parsing                        │
│  - Response streaming coordination              │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│         Output Formatters                       │
│  - outputReadResultsJSON()                      │
│  - outputReadResultsNDJSON()                    │
│  - outputReadResultsStream()                    │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│      Data Streaming Abstraction                 │
│  - ResultStream<T> class                        │
│  - Iterator-based result delivery               │
│  - Backpressure handling                        │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┘
│      Authorization Layer                        │
│  - readStream() method (new)                    │
│  - Yields results incrementally                 │
└─────────────────────────────────────────────────┘
```

### Design Pattern: Follow Existing `/load` Pattern

The `/load` endpoint (lines 345-349) already demonstrates the correct pattern:

```typescript
router.post('/load', applyAllowOrigin, post(
    parseLoadMessage,
    (user, loadMessage) => this.load(user, loadMessage),
    outputGraph  // Content negotiation in separate function
));
```

The `outputGraph` function (lines 304-320) shows proper content negotiation:

```typescript
function outputGraph(result: FactEnvelope[], res: Response, accepts: (type: string) => string | false) {
    if (accepts("application/x-jinaga-graph-v1")) {
        res.type("application/x-jinaga-graph-v1");
        const serializer = new GraphSerializer(
            (chunk: string) => res.write(chunk)
        );
        serializer.serialize(result);
        res.end();
    }
    else {
        res.type("json");
        const loadResponse: LoadResponse = {
            facts: result.map(r => r.fact)
        };
        res.send(JSON.stringify(loadResponse));
    }
}
```

### Recommended Solution 1: Minimal Changes (Backward Compatible)

**Goal**: Add content negotiation while maintaining current array-based API

#### Step 1: Create Output Formatter Function

```typescript
function outputReadResults(
    result: any[], 
    res: Response, 
    accepts: (type: string) => string | false
): void {
    if (accepts("application/x-ndjson")) {
        // Newline-delimited JSON for streaming clients
        res.type("application/x-ndjson");
        res.set("Transfer-Encoding", "chunked");
        for (const item of result) {
            res.write(JSON.stringify(item) + "\n");
        }
        res.end();
    }
    else if (accepts("text/plain")) {
        // Pretty-printed JSON for human readability
        res.type("text/plain");
        res.send(JSON.stringify(result, null, 2));
    }
    else {
        // Default: compact JSON
        res.type("application/json");
        res.send(JSON.stringify(result));
    }
}
```

#### Step 2: Update Router Configuration

```typescript
router.post('/read', applyAllowOrigin, post(
    parseString,
    (user, input: string) => this.read(user, input),
    outputReadResults  // New output formatter
));
```

**Benefits:**
- ✅ Adds content negotiation
- ✅ Minimal code changes
- ✅ Backward compatible
- ✅ Follows existing pattern

**Limitations:**
- ❌ Still loads all results into memory
- ❌ Cannot stream from database layer

---

### Recommended Solution 2: Full Streaming (Advanced)

**Goal**: Stream results incrementally from database to client

#### Step 1: Define Result Stream Interface

```typescript
// src/http/result-stream.ts
export interface ResultStream<T> {
    next(): Promise<T | null>;
    close(): void;
}

export class AsyncIterableResultStream<T> implements ResultStream<T> {
    private iterator: AsyncIterator<T>;
    private done = false;

    constructor(iterable: AsyncIterable<T>) {
        this.iterator = iterable[Symbol.asyncIterator]();
    }

    async next(): Promise<T | null> {
        if (this.done) return null;
        
        const result = await this.iterator.next();
        if (result.done) {
            this.done = true;
            return null;
        }
        return result.value;
    }

    close(): void {
        this.done = true;
        if (this.iterator.return) {
            this.iterator.return();
        }
    }
}
```

#### Step 2: Create Streaming Output Formatters

```typescript
// src/http/output-formatters.ts
async function outputReadResultsStreaming(
    streamOrArray: ResultStream<any> | any[],
    res: Response,
    accepts: (type: string) => string | false
): Promise<void> {
    // Convert array to stream if needed
    const stream = Array.isArray(streamOrArray)
        ? arrayToResultStream(streamOrArray)
        : streamOrArray;

    try {
        if (accepts("application/x-ndjson")) {
            await streamAsNDJSON(stream, res);
        }
        else if (accepts("application/x-jinaga-results-stream")) {
            await streamAsBinary(stream, res);
        }
        else {
            // Fallback: collect all results and send as JSON
            await collectAndSendJSON(stream, res);
        }
    }
    finally {
        stream.close();
    }
}

async function streamAsNDJSON(
    stream: ResultStream<any>, 
    res: Response
): Promise<void> {
    res.type("application/x-ndjson");
    res.set("Transfer-Encoding", "chunked");
    res.flushHeaders();

    let item: any;
    while ((item = await stream.next()) !== null) {
        res.write(JSON.stringify(item) + "\n");
    }
    res.end();
}

async function streamAsBinary(
    stream: ResultStream<any>,
    res: Response
): Promise<void> {
    res.type("application/x-jinaga-results-stream");
    res.set("Transfer-Encoding", "chunked");
    res.flushHeaders();

    const serializer = new ResultSerializer(
        (chunk: string) => res.write(chunk)
    );

    let item: any;
    while ((item = await stream.next()) !== null) {
        serializer.serializeResult(item);
    }
    res.end();
}

async function collectAndSendJSON(
    stream: ResultStream<any>,
    res: Response
): Promise<void> {
    const results: any[] = [];
    let item: any;
    while ((item = await stream.next()) !== null) {
        results.push(item);
    }
    
    res.type("application/json");
    res.send(JSON.stringify(results));
}

function arrayToResultStream<T>(array: T[]): ResultStream<T> {
    let index = 0;
    return {
        async next(): Promise<T | null> {
            if (index >= array.length) return null;
            return array[index++];
        },
        close(): void {
            index = array.length;
        }
    };
}
```

#### Step 3: Update Authorization Layer

```typescript
// In authorization layer - add streaming method
interface Authorization {
    read(
        userIdentity: UserIdentity | null,
        start: FactReference[],
        specification: Specification
    ): Promise<ProjectedResult[]>;
    
    // New streaming method
    readStream(
        userIdentity: UserIdentity | null,
        start: FactReference[],
        specification: Specification
    ): AsyncIterable<ProjectedResult>;
}
```

#### Step 4: Update Router to Support Both Patterns

```typescript
// Modify post() wrapper to handle streaming
function postWithStreaming<T, U>(
    parse: (input: any) => T,
    method: (user: RequestUser, message: T, params?: { [key: string]: string }) 
        => Promise<U | ResultStream<U>>,
    output: (result: U | ResultStream<U>, res: Response, accepts: (type: string) => string | false) 
        => Promise<void> | void
): Handler {
    return async (req, res, next) => {
        const user = <RequestUser>(req as any).user;
        const message = parse(req.body);
        if (!message) {
            throw new Error('Ensure that you have called app.use(express.json()).');
        }
        
        try {
            const response = await method(user, message, req.params);
            if (!response) {
                res.sendStatus(404);
                next();
            }
            else {
                await output(response, res, (type) => req.accepts(type));
                next();
            }
        }
        catch (error) {
            handleError(error, req, res, next);
        }
    };
}

// Updated router configuration
router.post('/read', applyAllowOrigin, postWithStreaming(
    parseString,
    (user, input: string) => this.readWithStreaming(user, input),
    outputReadResultsStreaming
));
```

#### Step 5: Implement Streaming Read Method

```typescript
private async readWithStreaming(
    user: RequestUser | null, 
    input: string
): Promise<ResultStream<any>> {
    return Trace.dependency("read", "", async () => {
        const knownFacts = await this.getKnownFacts(user);
        const parser = new SpecificationParser(input);
        parser.skipWhitespace();
        const declaration = parser.parseDeclaration(knownFacts);
        const specification = parser.parseSpecification();
        parser.expectEnd();
        const start = this.selectStart(specification, declaration);

        var failures: string[] = this.factManager.testSpecificationForCompliance(specification);
        if (failures.length > 0) {
            throw new Invalid(failures.join("\n"));
        }

        const userIdentity = serializeUserIdentity(user);
        
        // Use streaming API if available
        if (this.authorization.readStream) {
            const iterable = this.authorization.readStream(
                userIdentity, 
                start, 
                specification
            );
            return new AsyncIterableResultStream(
                extractResultsStreaming(iterable)
            );
        }
        
        // Fallback to array-based API
        const results = await this.authorization.read(
            userIdentity, 
            start, 
            specification
        );
        const extracted = extractResults(results);
        return arrayToResultStream(extracted.result);
    });
}

// Helper to stream extraction
async function* extractResultsStreaming(
    iterable: AsyncIterable<ProjectedResult>
): AsyncIterable<any> {
    for await (const result of iterable) {
        const extracted = extractResults(result.result);
        yield extracted.result;
    }
}
```

**Benefits:**
- ✅ True streaming from database to client
- ✅ Constant memory usage regardless of result set size
- ✅ Supports multiple formats
- ✅ Backward compatible (fallback to array)
- ✅ Follows existing patterns (`Stream<T>`, `GraphSerializer`)

**Trade-offs:**
- More complex implementation
- Requires changes to authorization layer
- Need to implement backpressure handling

---

### Recommended Solution 3: Hybrid Approach (Recommended)

**Goal**: Combine both approaches for gradual migration

#### Phase 1: Add Content Negotiation (Immediate)
- Implement Solution 1
- Add `outputReadResults` function
- Update router configuration
- No breaking changes

#### Phase 2: Add Streaming Infrastructure (Medium-term)
- Implement `ResultStream<T>` interface
- Create streaming output formatters
- Keep array-based API as fallback

#### Phase 3: Optimize Data Layer (Long-term)
- Add `readStream()` to authorization layer
- Implement database cursor-based streaming
- Gradually migrate to streaming by default

---

## Implementation Recommendations

### Content Type Support Matrix

| Accept Header | Output Format | Streaming | Use Case |
|---------------|---------------|-----------|----------|
| `application/json` | Compact JSON array | No | API clients (default) |
| `text/plain` | Pretty JSON | No | Human debugging |
| `application/x-ndjson` | Newline-delimited JSON | Yes | Streaming clients |
| `application/x-jinaga-results-stream` | Binary format | Yes | High performance |

### Update OPTIONS Handler

```typescript
this.setOptions(router, '/read')
    .intendedForPost('text/plain')
    .returningContent('application/json', 'text/plain', 'application/x-ndjson');
```

### Error Handling with Streaming

```typescript
async function streamAsNDJSON(stream: ResultStream<any>, res: Response): Promise<void> {
    res.type("application/x-ndjson");
    res.set("Transfer-Encoding", "chunked");
    res.flushHeaders();

    try {
        let item: any;
        while ((item = await stream.next()) !== null) {
            res.write(JSON.stringify(item) + "\n");
        }
        res.end();
    }
    catch (error) {
        // With chunked encoding, we've already started sending
        // Send error as special NDJSON line
        res.write(JSON.stringify({
            error: true,
            message: error.message
        }) + "\n");
        res.end();
    }
}
```

### Testing Strategy

1. **Unit Tests**: Test output formatters with mock streams
2. **Integration Tests**: Test with small and large result sets
3. **Load Tests**: Verify memory usage stays constant during streaming
4. **Compatibility Tests**: Ensure existing clients work with default JSON

---

## Migration Path

### Backward Compatibility

All solutions maintain backward compatibility:
- Default Accept header returns JSON array (current behavior)
- Existing clients receive same response format
- New capabilities opt-in via Accept header

### Gradual Adoption

```typescript
// Old code continues to work
const results = await fetch('/read', {
    method: 'POST',
    body: specification
});
const data = await results.json(); // Array of results

// New streaming-aware code
const results = await fetch('/read', {
    method: 'POST',
    headers: { 'Accept': 'application/x-ndjson' },
    body: specification
});
const reader = results.body.getReader();
// Stream results incrementally
```

---

## Comparison with Existing Patterns

### Similar to `/feeds/:hash` Streaming Pattern

The `/feeds/:hash` endpoint (lines 362-364) shows the streaming pattern:

```typescript
router.get('/feeds/:hash', applyAllowOrigin, getOrStream<FeedResponse>(
    (user, params, query) => this.feed(user, params, query),
    (user, params, query) => this.streamFeed(user, params, query)
));
```

The `getOrStream` function (lines 38-170) demonstrates:
- Content negotiation based on Accept header
- Separate streaming and non-streaming code paths
- Use of `Stream<T>` class for managing stream lifecycle

**Apply same pattern to `/read`:**
```typescript
router.post('/read', applyAllowOrigin, postOrStream<ReadResponse>(
    (user, input) => this.read(user, input),
    (user, input) => this.streamRead(user, input)
));
```

---

## Conclusion

### Recommended Implementation Order

1. **Immediate** (Solution 1): Add `outputReadResults` formatter function
   - Low risk, high value
   - Enables content negotiation
   - ~2-4 hours implementation

2. **Short-term** (Solution 2, Phase 1-2): Add streaming infrastructure
   - Moderate complexity
   - Enables large result set handling
   - ~1-2 days implementation

3. **Long-term** (Solution 2, Phase 3): Optimize data layer
   - Requires database layer changes
   - Maximum performance benefit
   - ~1 week implementation

### Key Principles

✅ **Separation of Concerns**: HTTP logic separate from data handling  
✅ **Content Negotiation**: Support multiple formats via Accept header  
✅ **Streaming Support**: Incremental data transfer for large result sets  
✅ **Backward Compatibility**: Existing clients continue to work  
✅ **Consistent Patterns**: Follow existing `/load` and `/feeds` patterns  

### Next Steps

1. Review and approve architectural approach
2. Implement Solution 1 (content negotiation) first
3. Create POC for streaming infrastructure
4. Performance test with large result sets
5. Document API changes for clients