# Diagnostic Logging for StreamFeed Push Notification Issues

This document describes the comprehensive diagnostic logging system implemented to identify why some clients fail to receive push notifications when multiple clients are simultaneously connected to streaming feeds.

## Overview

The diagnostic logging has been added to track:
1. **Listener Management** - Registration/deregistration of specification listeners
2. **Event Broadcasting** - How events are distributed to listeners
3. **Stream State Changes** - Stream lifecycle and data flow
4. **Connection Management** - HTTP connection lifecycle and cleanup
5. **Concurrent Access Patterns** - Race conditions and timing issues

## Components Modified

### 1. ObservableSource (`../jinaga.js/src/observable/observable.ts`)

**Added logging for:**
- Listener registration with counts and specification details
- Listener removal with timing and race condition detection
- Event notification sequences with performance metrics
- Race condition detection during listener array modifications

**Key log patterns to watch for:**
```
[ObservableSource] RACE CONDITION DETECTED - Listener count changed during snapshot
[ObservableSource] Listener NOT FOUND during removal
[ObservableSource] SLOW notification - Duration: >100ms
```

### 2. Stream Class (`src/http/stream.ts`)

**Added logging for:**
- Stream creation with unique IDs
- Handler registration and data replay
- Feed operations with performance tracking
- Stream closure and cleanup
- Error handling in handlers

**Key log patterns to watch for:**
```
[Stream:ID] Attempted to feed data to closed stream
[Stream:ID] SLOW handler - Duration: >50ms
[Stream:ID] ERROR in handler
```

### 3. StreamFeed Function (`src/http/router.ts`)

**Added logging for:**
- Connection establishment with unique IDs
- Initial data streaming progress
- Real-time listener setup
- Event processing and filtering
- Connection cleanup and resource management

**Key log patterns to watch for:**
```
[StreamFeed:ID] EVENT RECEIVED - Results: X
[StreamFeed:ID] No matching results - skipping response
[StreamFeed:ID] SLOW event processing - Duration: >100ms
```

### 4. HTTP Connection Management (`src/http/router.ts`)

**Added logging for:**
- Client connection/disconnection events
- Message transmission with timing
- Timeout handling
- Socket management
- Error conditions

**Key log patterns to watch for:**
```
[HttpConnection:ID] CLIENT DISCONNECTED
[HttpConnection:ID] TIMEOUT TRIGGERED
[HttpConnection:ID] SLOW write operation - Duration: >50ms
```

## How to Use the Diagnostic Logging

### 1. Enable Logging

The logging uses both `console.log` and the existing `Trace` system. Ensure your application is configured to capture both:

```javascript
// For console logs
process.env.NODE_ENV = 'development';

// For Trace logs (if using structured logging)
// Configure your trace system to capture info/warn/error levels
```

### 2. Run the Test Script

Use the provided test script to simulate concurrent connections:

```bash
# Replace 'your-feed-hash' with an actual feed hash from your system
node test-concurrent-streams.js your-feed-hash-here
```

The test script will:
- Create 5 concurrent streaming connections
- Stagger connections by 1 second each
- Monitor message distribution for 30 seconds
- Report statistics and detect potential issues

### 3. Analyze the Logs

Look for these critical patterns in the logs:

#### Race Condition Indicators
```
[ObservableSource] RACE CONDITION DETECTED - Listener count changed during snapshot
[ObservableSource] Listener NOT FOUND during removal
```

#### Performance Issues
```
[StreamFeed:ID] SLOW event processing - Duration: >100ms
[HttpConnection:ID] SLOW write operation - Duration: >50ms
[Stream:ID] SLOW handler - Duration: >50ms
```

#### Connection Issues
```
[HttpConnection:ID] Attempted to write to disconnected client
[Stream:ID] Attempted to feed data to closed stream
```

#### Event Distribution Problems
```
[StreamFeed:ID] No matching results - skipping response
[ObservableSource] Processing spec X/Y - Listeners: 0
```

### 4. Expected Behavior vs Issues

**Normal Operation:**
- All clients should receive similar message counts
- Event processing should be fast (<100ms)
- No race condition warnings
- Clean connection cleanup

**Problem Indicators:**
- Significant variance in message counts between clients
- Race condition warnings in ObservableSource
- Slow event processing times
- Errors during listener removal
- Messages sent to closed streams

## Monitoring Recommendations

### 1. Real-time Monitoring

Set up log aggregation to monitor these patterns in production:

```bash
# Example: Monitor for race conditions
tail -f application.log | grep "RACE CONDITION DETECTED"

# Example: Monitor for slow operations
tail -f application.log | grep "SLOW"

# Example: Monitor connection issues
tail -f application.log | grep "CLIENT DISCONNECTED\|TIMEOUT TRIGGERED"
```

### 2. Metrics to Track

- **Message Distribution Variance**: Difference between max and min messages received by clients
- **Event Processing Time**: Average time to process and distribute events
- **Connection Cleanup Time**: Time taken to remove listeners during disconnection
- **Race Condition Frequency**: Number of race condition warnings per hour

### 3. Alerting Thresholds

Consider setting up alerts for:
- Race condition warnings (any occurrence)
- Event processing time >500ms
- Message distribution variance >10 messages
- Connection cleanup time >1000ms

## Next Steps

After collecting diagnostic data:

1. **Identify Root Cause**: Use the logs to confirm which of the suspected issues is occurring
2. **Implement Fixes**: Based on findings, implement appropriate synchronization mechanisms
3. **Validate Fixes**: Re-run tests to confirm issues are resolved
4. **Performance Tuning**: Optimize any slow operations identified

## Suspected Issues Being Tracked

1. **Race Conditions in Listener Management**: ObservableSource listener array modifications during concurrent access
2. **Shared State Corruption**: Event broadcasting while listeners are being modified
3. **Stream State Management**: Race conditions between stream closure and data feeding
4. **Connection Cleanup Timing**: Double cleanup or cleanup during active operations
5. **Async Event Processing**: Out-of-order bookmark updates causing missed notifications

The diagnostic logging will help confirm which of these issues is the primary cause of the selective push notification failures.