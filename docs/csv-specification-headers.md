# CSV Headers from Specification - Design Document

## Overview

This document explains how to modify the streaming CSV implementation to:
1. Use the `csv-stringify` library for robust CSV generation
2. Derive CSV headers from the request specification (not response objects)
3. Validate that projections are flat when CSV format is requested

## Problem Statement

Current implementation has limitations:
- Headers extracted from first response object (unreliable if no results)
- Manual CSV escaping (reinventing the wheel)
- No validation that projection structure is suitable for CSV
- Cannot handle missing fields gracefully

## Solution Architecture

### 1. Specification Parsing & Validation

When CSV is requested, parse the specification to:
- Extract projection labels (these become CSV headers)
- Validate each projection is "flat" (single-valued)
- Reject specifications with arrays, nested objects, or existential quantifiers

### 2. Projection Types

**Valid for CSV (Flat/Single-Valued):**
```javascript
// Fields (scalar values)
{
  name: item.name,           // ✅ String field
  count: item.count,         // ✅ Number field
  active: item.active        // ✅ Boolean field
}

// Hashes
{
  itemHash: item.hash        // ✅ Hash value
}

// Timestamps
{
  created: item.createdAt    // ✅ Timestamp
}

// Predecessor fields
{
  parentName: item.parent.name  // ✅ Scalar from predecessor
}
```

**Invalid for CSV (Multi-Valued/Complex):**
```javascript
// Arrays (existential quantifiers)
{
  tags: item.tags            // ❌ Array of tags
}

// Nested projections
{
  parent: {                  // ❌ Nested object
    name: item.parent.name,
    id: item.parent.id
  }
}

// Multiple values
{
  children: [                // ❌ Array of objects
    child.name,
    child.age
  ]
}
```

## Implementation

### Step 1: Add CSV Metadata Type

```typescript
// src/http/csv-metadata.ts

/**
 * Metadata for CSV export derived from specification
 */
export interface CsvMetadata {
    /** Column headers in order */
    headers: string[];
    
    /** Mapping from header name to projection path */
    projectionPaths: Map<string, string>;
    
    /** Whether the projection is valid for CSV */
    isValid: boolean;
    
    /** Validation errors if any */
    errors: string[];
}

/**
 * Projection component types
 */
export type ProjectionComponentType = 
    | 'field'        // Scalar field (string, number, boolean)
    | 'hash'         // Fact hash
    | 'timestamp'    // Timestamp value
    | 'predecessor'  // Field from predecessor
    | 'array'        // Array/collection (invalid for CSV)
    | 'nested'       // Nested object (invalid for CSV)
    | 'unknown';

/**
 * Information about a single projection component
 */
export interface ProjectionComponent {
    label: string;
    type: ProjectionComponentType;
    path: string;
    isValid: boolean;
    reason?: string;
}
```

### Step 2: Add Specification Validator

```typescript
// src/http/csv-validator.ts
import { Specification, ProjectedResult } from 'jinaga';
import { CsvMetadata, ProjectionComponent, ProjectionComponentType } from './csv-metadata';

/**
 * Validates a specification for CSV compatibility.
 * Returns metadata including headers and validation results.
 */
export function validateSpecificationForCsv(specification: Specification): CsvMetadata {
    const headers: string[] = [];
    const projectionPaths = new Map<string, string>();
    const errors: string[] = [];
    const components: ProjectionComponent[] = [];

    // Check if specification has projections
    if (!specification.projection || specification.projection.length === 0) {
        return {
            headers: [],
            projectionPaths,
            isValid: false,
            errors: ['Specification has no projections']
        };
    }

    // Analyze each projection component
    for (const projection of specification.projection) {
        const component = analyzeProjectionComponent(projection);
        components.push(component);

        if (component.isValid) {
            headers.push(component.label);
            projectionPaths.set(component.label, component.path);
        } else {
            errors.push(
                `Projection "${component.label}" is invalid for CSV: ${component.reason}`
            );
        }
    }

    return {
        headers,
        projectionPaths,
        isValid: errors.length === 0,
        errors
    };
}

/**
 * Analyzes a single projection component to determine if it's CSV-compatible
 */
function analyzeProjectionComponent(projection: any): ProjectionComponent {
    const label = projection.name || projection.label;
    
    // Check if it's an array (existential quantifier)
    if (projection.quantifier === 'existential') {
        return {
            label,
            type: 'array',
            path: getProjectionPath(projection),
            isValid: false,
            reason: 'Array projections (existential quantifiers) are not supported in CSV format'
        };
    }

    // Check if it's a nested projection
    if (projection.projection && Array.isArray(projection.projection) && projection.projection.length > 0) {
        return {
            label,
            type: 'nested',
            path: getProjectionPath(projection),
            isValid: false,
            reason: 'Nested object projections are not supported in CSV format'
        };
    }

    // Determine the type of scalar projection
    const type = determineScalarType(projection);
    
    if (type === 'unknown') {
        return {
            label,
            type,
            path: getProjectionPath(projection),
            isValid: false,
            reason: 'Unknown projection type'
        };
    }

    return {
        label,
        type,
        path: getProjectionPath(projection),
        isValid: true
    };
}

/**
 * Determines the type of a scalar projection
 */
function determineScalarType(projection: any): ProjectionComponentType {
    // Check for hash
    if (projection.type === 'hash' || projection.path?.endsWith('.hash')) {
        return 'hash';
    }

    // Check for timestamp
    if (projection.type === 'timestamp' || 
        projection.fieldName?.toLowerCase().includes('time') ||
        projection.fieldName?.toLowerCase().includes('date')) {
        return 'timestamp';
    }

    // Check for predecessor field (path with multiple segments)
    if (projection.path && projection.path.includes('.') && !projection.path.endsWith('.hash')) {
        return 'predecessor';
    }

    // Check for simple field
    if (projection.fieldName || projection.field) {
        return 'field';
    }

    return 'unknown';
}

/**
 * Gets the full path of a projection for debugging
 */
function getProjectionPath(projection: any): string {
    if (projection.path) return projection.path;
    if (projection.fieldName) return projection.fieldName;
    if (projection.field) return projection.field;
    return '<unknown>';
}

/**
 * Extract value from result object using projection path
 */
export function extractValueByPath(result: any, path: string): any {
    const parts = path.split('.');
    let value = result;
    
    for (const part of parts) {
        if (value == null) return null;
        value = value[part];
    }
    
    return value;
}
```

### Step 3: Modify Router to Parse and Validate

```typescript
// src/http/router.ts (additions)
import { validateSpecificationForCsv } from './csv-validator';
import { CsvMetadata } from './csv-metadata';

// Modify postReadWithStreaming to accept Accept header early
function postReadWithStreaming(
    method: (user: RequestUser, message: string, acceptType: string) => Promise<any[] | ResultStream<any>>
): Handler {
    return (req, res, next) => {
        const user = <RequestUser>(req as any).user;
        const input = parseString(req.body);
        if (!input || typeof (input) !== 'string') {
            res.type("text");
            res.status(500).send('Expected Content-Type text/plain. Ensure that you have called app.use(express.text()).');
        }
        else {
            // Get accepted type before calling method
            const acceptType = req.accepts(['text/csv', 'application/x-ndjson', 'application/json', 'text/plain']) || 'text/plain';
            
            method(user, input, acceptType)
                .then(response => {
                    if (!response) {
                        res.sendStatus(404);
                        next();
                    }
                    else {
                        outputReadResults(response, res, (type) => req.accepts(type));
                        next();
                    }
                })
                .catch(error => handleError(error, req, res, next));
        }
    };
}

// Modify readWithStreaming to validate CSV requests
private async readWithStreaming(
    user: RequestUser | null, 
    input: string,
    acceptType: string
): Promise<any[] | ResultStream<any>> {
    return Trace.dependency("readWithStreaming", "", async () => {
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

        // NEW: Validate specification for CSV if CSV is requested
        if (acceptType === 'text/csv') {
            const csvMetadata = validateSpecificationForCsv(specification);
            if (!csvMetadata.isValid) {
                throw new Invalid(
                    `Specification is not compatible with CSV format:\n` +
                    csvMetadata.errors.join('\n')
                );
            }
            // Store metadata for output formatter
            (specification as any).__csvMetadata = csvMetadata;
        }

        const userIdentity = serializeUserIdentity(user);
        
        // Check if authorization supports streaming
        if (typeof (this.authorization as any).readStream === 'function') {
            const streamResults = await (this.authorization as any).readStream(
                userIdentity, start, specification
            );
            Trace.counter("facts_read_streaming", 1);
            
            if (streamResults && typeof streamResults[Symbol.asyncIterator] === 'function') {
                return new AsyncIterableResultStream(streamResults);
            }
            
            if (streamResults && typeof streamResults.next === 'function') {
                return streamResults;
            }
        }
        
        // Fallback to array-based read
        const results = await this.authorization.read(userIdentity, start, specification);
        const extracted = extractResults(results);
        Trace.counter("facts_read", extracted.count);
        return extracted.result;
    });
}
```

### Step 4: Modify Output Formatter to Use csv-stringify

```typescript
// src/http/output-formatters.ts (modified)
import { Response } from "express";
import { stringify } from 'csv-stringify';
import { ResultStream, arrayToResultStream } from "./result-stream";
import { CsvMetadata } from './csv-metadata';
import { extractValueByPath } from './csv-validator';

/**
 * Output read results with streaming support.
 * Handles content negotiation and streams data when possible.
 */
export async function outputReadResultsStreaming(
    result: any[] | ResultStream<any>,
    res: Response,
    accepts: (type: string) => string | false,
    csvMetadata?: CsvMetadata  // NEW: Optional CSV metadata
): Promise<void> {
    // Convert array to stream if needed
    const stream = Array.isArray(result) ? arrayToResultStream(result) : result;

    if (accepts("application/x-ndjson")) {
        await streamAsNDJSON(stream, res);
    }
    else if (accepts("text/csv")) {
        if (!csvMetadata) {
            throw new Error('CSV metadata is required for CSV output');
        }
        await streamAsCSVWithStringify(stream, res, csvMetadata);
    }
    else {
        await collectAndSendJSON(stream, res, accepts);
    }
}

/**
 * Stream results as CSV using csv-stringify library.
 * Headers are provided from the specification, not extracted from data.
 */
export async function streamAsCSVWithStringify(
    stream: ResultStream<any>,
    res: Response,
    csvMetadata: CsvMetadata
): Promise<void> {
    res.type("text/csv");

    return new Promise(async (resolve, reject) => {
        try {
            // Create csv-stringify stringifier
            const stringifier = stringify({
                header: true,
                columns: csvMetadata.headers,
                cast: {
                    // Custom casting for special types
                    boolean: (value) => value ? 'true' : 'false',
                    date: (value) => value.toISOString(),
                    object: (value) => {
                        // Handle nested objects by JSON stringifying
                        if (value && typeof value === 'object') {
                            if (value.type && value.hash) {
                                // Fact reference - just use hash
                                return value.hash;
                            }
                            return JSON.stringify(value);
                        }
                        return String(value);
                    }
                }
            });

            // Pipe to response
            stringifier.pipe(res);

            // Handle stringifier errors
            stringifier.on('error', (err) => {
                console.error('CSV stringify error:', err);
                reject(err);
            });

            stringifier.on('finish', () => {
                resolve();
            });

            // Stream data through stringifier
            let item: any = null;
            while ((item = await stream.next()) !== null) {
                // Extract values in header order
                const row: any = {};
                for (const header of csvMetadata.headers) {
                    const path = csvMetadata.projectionPaths.get(header);
                    if (path) {
                        row[header] = extractValueByPath(item, header) ?? '';
                    } else {
                        row[header] = item[header] ?? '';
                    }
                }
                
                // Write row to stringifier
                stringifier.write(row);
            }

            // Signal end of data
            stringifier.end();

        } catch (error) {
            console.error('Error in CSV streaming:', error);
            if (!res.headersSent) {
                res.status(500).send('Error generating CSV');
            }
            reject(error);
        } finally {
            await stream.close();
        }
    });
}

// Keep old streamAsCSV as fallback for non-specification use cases
export async function streamAsCSV(
    stream: ResultStream<any>,
    res: Response
): Promise<void> {
    // This is the original implementation for backward compatibility
    // when CSV is generated without specification metadata
    res.type("text/csv");

    try {
        let isFirstRow = true;
        let headers: string[] = [];

        let item: any = null;
        while ((item = await stream.next()) !== null) {
            if (isFirstRow) {
                headers = Object.keys(item);
                res.write(headers.map(escapeCSV).join(',') + '\n');
                isFirstRow = false;
            }

            const values = headers.map(key => {
                const value = item[key];
                if (value === null || value === undefined) {
                    return '';
                }
                if (typeof value === 'object') {
                    return escapeCSV(JSON.stringify(value));
                }
                return escapeCSV(String(value));
            });
            res.write(values.join(',') + '\n');
        }

        if (isFirstRow) {
            res.write('');
        }

        res.end();
    } catch (error) {
        res.end();
    } finally {
        await stream.close();
    }
}

function escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}
```

### Step 5: Update Router Integration

```typescript
// src/http/router.ts (modify outputReadResults)

function outputReadResults(
    result: any[] | ResultStream<any>, 
    res: Response, 
    accepts: (type: string) => string | false
) {
    // Extract CSV metadata if it was attached to the result
    let csvMetadata: CsvMetadata | undefined;
    if (Array.isArray(result) && (result as any).__csvMetadata) {
        csvMetadata = (result as any).__csvMetadata;
    }

    // Use streaming output formatter
    outputReadResultsStreaming(result, res, accepts, csvMetadata)
        .catch(error => {
            console.error('Error in outputReadResults:', error);
            if (!res.headersSent) {
                res.status(500).send('Internal server error');
            }
        });
}
```

## Usage Examples

### Valid CSV Request

```
POST /read
Content-Type: text/plain
Accept: text/csv

user = {"type": "User", "hash": "abc123"}

(user: User) {
  name: user.name,
  email: user.email,
  createdAt: user.createdAt,
  userHash: user.hash
}
```

Response:
```csv
name,email,createdAt,userHash
"Alice","alice@example.com","2024-01-15T10:30:00Z","abc123"
"Bob","bob@example.com","2024-01-16T11:00:00Z","def456"
```

### Invalid CSV Request (Nested Projection)

```
POST /read
Accept: text/csv

(user: User) {
  profile: {
    name: user.name,
    email: user.email
  }
}
```

Response:
```
400 Bad Request
Specification is not compatible with CSV format:
Projection "profile" is invalid for CSV: Nested object projections are not supported in CSV format
```

### Invalid CSV Request (Array)

```
POST /read
Accept: text/csv

(blog: Blog) {
  posts: blog.posts
}
```

Response:
```
400 Bad Request
Specification is not compatible with CSV format:
Projection "posts" is invalid for CSV: Array projections (existential quantifiers) are not supported in CSV format
```

## Benefits

### 1. Reliability
- Headers defined upfront, not dependent on response data
- Empty result sets still produce valid CSV with headers
- Consistent column order

### 2. Validation
- Early detection of incompatible projections
- Clear error messages for users
- Prevents runtime errors

### 3. Robustness
- `csv-stringify` handles edge cases (quotes, newlines, special characters)
- Proper type casting (dates, booleans, nulls)
- Stream-based processing (constant memory)

### 4. Flexibility
- Headers match specification labels
- Works with any single-valued projection
- Supports predecessor traversal

## Testing Strategy

### Unit Tests

```typescript
describe('CSV Validation', () => {
    it('should accept flat field projections', () => {
        const spec = parseSpecification(`
            (item: Item) {
                name: item.name,
                count: item.count
            }
        `);
        const metadata = validateSpecificationForCsv(spec);
        expect(metadata.isValid).toBe(true);
        expect(metadata.headers).toEqual(['name', 'count']);
    });

    it('should reject array projections', () => {
        const spec = parseSpecification(`
            (user: User) {
                posts: user.posts
            }
        `);
        const metadata = validateSpecificationForCsv(spec);
        expect(metadata.isValid).toBe(false);
        expect(metadata.errors).toContain('Array projections');
    });

    it('should reject nested projections', () => {
        const spec = parseSpecification(`
            (user: User) {
                profile: {
                    name: user.name
                }
            }
        `);
        const metadata = validateSpecificationForCsv(spec);
        expect(metadata.isValid).toBe(false);
        expect(metadata.errors).toContain('Nested object');
    });
});
```

### Integration Tests

```typescript
describe('CSV with Specification Headers', () => {
    it('should use specification labels as CSV headers', async () => {
        // Create test data
        const root = await j.fact(new Root('test'));
        await j.fact(new Item('item1', 10, root));
        await j.fact(new Item('item2', 20, root));

        const spec = `
            root = ${JSON.stringify(root)}
            
            (root: Root) {
              itemName: item.name,
              itemCount: item.count
            }
        `;

        const response = await request(app)
            .post('/read')
            .set('Accept', 'text/csv')
            .send(spec);

        expect(response.status).toBe(200);
        
        const lines = response.text.split('\n');
        expect(lines[0]).toBe('itemName,itemCount');
        expect(lines[1]).toContain('item1,10');
        expect(lines[2]).toContain('item2,20');
    });

    it('should return 400 for invalid CSV projection', async () => {
        const spec = `
            (root: Root) {
              items: root.items
            }
        `;

        const response = await request(app)
            .post('/read')
            .set('Accept', 'text/csv')
            .send(spec);

        expect(response.status).toBe(400);
        expect(response.text).toContain('Array projections');
    });
});
```

## Migration Path

1. **Phase 1:** Add csv-validator and csv-metadata modules
2. **Phase 2:** Update router to call validator when CSV requested
3. **Phase 3:** Implement streamAsCSVWithStringify
4. **Phase 4:** Update outputReadResults to pass metadata
5. **Phase 5:** Add tests
6. **Phase 6:** Deprecate old streamAsCSV (keep for backward compatibility)

## Error Handling

### Invalid Specification
- HTTP 400 with clear error message
- Lists all invalid projections
- Explains why each is invalid

### Runtime Errors
- Caught and logged
- HTTP 500 if headers not sent
- Graceful stream termination

### Empty Results
- Valid CSV with headers only
- No 404 (empty result set is valid)

## Performance Considerations

- **Validation:** O(n) where n = number of projections (typically < 20)
- **Memory:** O(1) - streaming through csv-stringify
- **CPU:** csv-stringify is optimized C++ code (very fast)
- **Network:** Backpressure handled by Node.js streams

## Conclusion

This design provides:
- ✅ Reliable CSV generation with proper headers
- ✅ Early validation of projection structure
- ✅ Robust handling via csv-stringify
- ✅ Clear error messages
- ✅ Backward compatibility
- ✅ Stream-based efficiency

The implementation ensures CSV exports are predictable, valid, and suitable for spreadsheet applications.
