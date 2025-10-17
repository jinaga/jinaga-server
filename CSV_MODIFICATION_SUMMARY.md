# CSV Modification Summary

## Quick Overview

Three key modifications to improve CSV export:

1. **Use csv-stringify library** (already a dependency)
2. **Derive headers from specification** (not response data)
3. **Validate projections are flat** (single-valued only)

## Architecture Changes

```
Request → Router → Validate Spec → Execute Query → Stream CSV
                      ↓                               ↑
                  CSV Metadata ──────────────────────┘
```

## Key Components

### 1. CSV Metadata (New)
```typescript
interface CsvMetadata {
    headers: string[];                    // From spec labels
    projectionPaths: Map<string, string>; // Label → path mapping
    isValid: boolean;                     // Validation result
    errors: string[];                     // Validation errors
}
```

### 2. Specification Validator (New)
```typescript
function validateSpecificationForCsv(spec: Specification): CsvMetadata {
    // Check each projection:
    // ✅ Fields, hashes, timestamps
    // ❌ Arrays, nested objects
    // Return metadata with headers or errors
}
```

### 3. Router Modification
```typescript
// Before query execution:
if (acceptType === 'text/csv') {
    const csvMetadata = validateSpecificationForCsv(specification);
    if (!csvMetadata.isValid) {
        throw new Invalid(csvMetadata.errors.join('\n'));
    }
    // Pass metadata to output formatter
}
```

### 4. CSV Streaming with csv-stringify
```typescript
import { stringify } from 'csv-stringify';

async function streamAsCSVWithStringify(
    stream: ResultStream<any>,
    res: Response,
    csvMetadata: CsvMetadata
): Promise<void> {
    const stringifier = stringify({
        header: true,
        columns: csvMetadata.headers  // ← From specification!
    });
    
    stringifier.pipe(res);
    
    while ((item = await stream.next()) !== null) {
        const row = {};
        for (const header of csvMetadata.headers) {
            row[header] = item[header] ?? '';
        }
        stringifier.write(row);
    }
    
    stringifier.end();
}
```

## Validation Rules

### ✅ Valid for CSV (Flat Projections)

```javascript
// Scalar fields
(item: Item) {
  name: item.name,          // ✅ String
  count: item.count,        // ✅ Number
  active: item.active       // ✅ Boolean
}

// Hashes and timestamps
(item: Item) {
  itemHash: item.hash,      // ✅ Hash
  created: item.createdAt   // ✅ Timestamp
}

// Predecessor fields
(item: Item) {
  parentName: item.parent.name  // ✅ Scalar from predecessor
}
```

### ❌ Invalid for CSV (Multi-Valued)

```javascript
// Arrays
(user: User) {
  posts: user.posts         // ❌ Collection
}

// Nested objects
(user: User) {
  profile: {                // ❌ Nested projection
    name: user.name,
    email: user.email
  }
}
```

## Example Requests

### Valid Request
```http
POST /read
Accept: text/csv

(user: User) {
  name: user.name,
  email: user.email,
  created: user.createdAt
}
```

Response:
```csv
name,email,created
"Alice","alice@example.com","2024-01-15T10:30:00Z"
"Bob","bob@example.com","2024-01-16T11:00:00Z"
```

### Invalid Request (Returns 400)
```http
POST /read
Accept: text/csv

(user: User) {
  profile: {
    name: user.name
  }
}
```

Response:
```
400 Bad Request
Specification is not compatible with CSV format:
Projection "profile" is invalid for CSV: Nested object projections are not supported
```

## Benefits

| Benefit | Before | After |
|---------|--------|-------|
| **Headers** | From first row | From specification |
| **Empty results** | No headers | Headers only |
| **Validation** | Runtime errors | Early validation |
| **Escaping** | Manual | csv-stringify |
| **Type handling** | Basic | Proper casting |

## Implementation Checklist

- [ ] Create `src/http/csv-metadata.ts` (types)
- [ ] Create `src/http/csv-validator.ts` (validation logic)
- [ ] Modify `src/http/router.ts` (add validation)
- [ ] Modify `src/http/output-formatters.ts` (use csv-stringify)
- [ ] Update `postReadWithStreaming()` handler
- [ ] Add unit tests for validation
- [ ] Add integration tests for CSV
- [ ] Update documentation

## Files to Modify

1. **src/http/csv-metadata.ts** (NEW) - Types
2. **src/http/csv-validator.ts** (NEW) - Validation
3. **src/http/router.ts** (MODIFY) - Add validation call
4. **src/http/output-formatters.ts** (MODIFY) - Use csv-stringify
5. **test/http/csv-validationSpec.ts** (NEW) - Unit tests
6. **integration-test/jinaga-test/read-csv.test.js** (MODIFY) - Update tests

## Code Snippet: Complete Flow

```typescript
// 1. Router receives CSV request
router.post('/read', async (req, res) => {
    const acceptType = req.accepts(['text/csv', ...]);
    
    // 2. Parse specification
    const spec = parseSpecification(input);
    
    // 3. Validate if CSV
    if (acceptType === 'text/csv') {
        const csvMeta = validateSpecificationForCsv(spec);
        if (!csvMeta.isValid) {
            return res.status(400).send(csvMeta.errors.join('\n'));
        }
        spec.__csvMetadata = csvMeta; // Attach metadata
    }
    
    // 4. Execute query
    const results = await executeQuery(spec);
    
    // 5. Output with csv-stringify
    await streamAsCSVWithStringify(results, res, spec.__csvMetadata);
});
```

## Testing Examples

```javascript
// Test 1: Valid flat projection
it('accepts flat projections', async () => {
    const response = await request(app)
        .post('/read')
        .set('Accept', 'text/csv')
        .send(`(item: Item) { name: item.name }`);
    
    expect(response.status).toBe(200);
    expect(response.text).toContain('name'); // Header
});

// Test 2: Reject nested projection
it('rejects nested projections', async () => {
    const response = await request(app)
        .post('/read')
        .set('Accept', 'text/csv')
        .send(`(item: Item) { profile: { name: item.name } }`);
    
    expect(response.status).toBe(400);
    expect(response.text).toContain('Nested object');
});

// Test 3: Empty results with headers
it('returns headers for empty results', async () => {
    const response = await request(app)
        .post('/read')
        .set('Accept', 'text/csv')
        .send(`(item: Item) { name: item.name }`);
    
    const lines = response.text.split('\n');
    expect(lines[0]).toBe('name'); // Header present
});
```

## Migration Notes

- **Backward compatible:** Old behavior preserved for non-CSV formats
- **No breaking changes:** Existing CSV usage still works
- **Opt-in validation:** Only validates when CSV is requested
- **Graceful degradation:** Falls back to old method if metadata missing

## Performance Impact

- **Validation:** < 1ms for typical specs (< 20 projections)
- **Streaming:** Same O(1) memory as before
- **CSV generation:** Faster (csv-stringify is optimized)
- **No additional dependencies:** csv-stringify already installed

## Next Steps

1. Review detailed design in `docs/csv-specification-headers.md`
2. Implement csv-metadata and csv-validator modules
3. Update router validation logic
4. Modify streamAsCSV to use csv-stringify
5. Add comprehensive tests
6. Update API documentation
