# Streaming Read Endpoint - Quick Start

## What's New?

The `/read` endpoint now supports **streaming responses** with **content negotiation** for efficient handling of large result sets.

## Quick Examples

### Default (Backward Compatible)
```http
POST /read
Content-Type: text/plain

(root: MyApp.Root) {
  items: MyApp.Item [ items->root: root ]
}
```
Returns pretty-printed JSON (2-space indentation) - same as before.

### Compact JSON
```http
POST /read
Content-Type: text/plain
Accept: application/json

[specification]
```
Returns compact JSON without whitespace.

### Streaming NDJSON (New!)
```http
POST /read
Content-Type: text/plain
Accept: application/x-ndjson

[specification]
```
Streams results as newline-delimited JSON. Each line is a separate JSON object.

### CSV Export (New!)
```http
POST /read
Content-Type: text/plain
Accept: text/csv

[specification]
```
Exports results as CSV with headers.

## Client Code Example

### JavaScript Streaming Client
```javascript
const response = await fetch('/read', {
  method: 'POST',
  headers: {
    'Content-Type': 'text/plain',
    'Accept': 'application/x-ndjson'
  },
  body: specification
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop(); // Keep incomplete line
  
  for (const line of lines) {
    if (line.trim()) {
      const result = JSON.parse(line);
      // Process each result immediately!
      console.log(result);
    }
  }
}
```

### Node.js Example
```javascript
const response = await fetch('/read', {
  method: 'POST',
  headers: {
    'Content-Type': 'text/plain',
    'Accept': 'application/json'
  },
  body: specification
});

const results = await response.json();
// Process all results at once
```

## Benefits

### Memory Efficiency
- **NDJSON/CSV:** Constant memory usage regardless of result size
- **JSON/text:** Same as before (all results in memory)

### Progressive Processing
- **NDJSON:** Start processing results before query completes
- **JSON/text:** Wait for complete response

### Format Flexibility
- **JSON:** Best for small-medium results
- **NDJSON:** Best for large results, streaming
- **CSV:** Best for spreadsheet export
- **text/plain:** Best for debugging

## Performance

Tested with:
- ✅ 1,000 results: Fast (~1-2 seconds)
- ✅ 5,000 results: Streaming starts immediately
- ✅ Concurrent requests: 5+ simultaneous streams supported

## Backward Compatibility

✅ **No breaking changes**
- Existing clients work without modification
- Default behavior unchanged
- Opt-in via Accept header

## Discovery

Check supported formats:
```http
OPTIONS /read
```

Response includes:
```
Accept-Post: text/plain, application/json, application/x-ndjson, text/csv
```

## Error Handling

### NDJSON
Errors sent as special JSON lines:
```json
{"error": true, "message": "Error description"}
```

### Other Formats
HTTP error codes returned before response starts.

## More Information

See full documentation:
- **Implementation Guide:** `docs/streaming-read-implementation.md`
- **Architecture Details:** `docs/design/read-endpoint-streaming-architecture.md`
- **Implementation Summary:** `IMPLEMENTATION_SUMMARY.md`
- **Changes:** `CHANGES.md`

## Testing

Run tests:
```bash
npm test                    # Unit tests
./integration-test/test.sh  # Integration tests
```

## Need Help?

Refer to:
1. Test files for usage examples
2. `docs/streaming-read-implementation.md` for complete guide
3. Source code (`src/http/`) for implementation details
