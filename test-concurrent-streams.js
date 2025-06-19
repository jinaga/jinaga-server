#!/usr/bin/env node

/**
 * Test script to simulate multiple concurrent clients connecting to streaming feeds
 * This will help validate the diagnostic logging and reproduce the push notification issues
 */

const http = require('http');
const { performance } = require('perf_hooks');

// Configuration
const SERVER_HOST = 'localhost';
const SERVER_PORT = 8080;
const FEED_HASH = 'your-feed-hash-here'; // Replace with actual feed hash
const NUM_CLIENTS = 5;
const CONNECTION_DURATION = 30000; // 30 seconds
const STAGGER_DELAY = 1000; // 1 second between client connections

class StreamingClient {
    constructor(clientId, feedHash) {
        this.clientId = clientId;
        this.feedHash = feedHash;
        this.messageCount = 0;
        this.connected = false;
        this.startTime = null;
        this.lastMessageTime = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            console.log(`[Client-${this.clientId}] Connecting to feed: ${this.feedHash}`);
            this.startTime = performance.now();

            const options = {
                hostname: SERVER_HOST,
                port: SERVER_PORT,
                path: `/feeds/${this.feedHash}`,
                method: 'GET',
                headers: {
                    'Accept': 'application/x-jinaga-feed-stream',
                    'Connection': 'keep-alive',
                    'Cache-Control': 'no-cache'
                }
            };

            const req = http.request(options, (res) => {
                console.log(`[Client-${this.clientId}] Connected - Status: ${res.statusCode}`);
                
                if (res.statusCode !== 200) {
                    console.error(`[Client-${this.clientId}] Connection failed with status: ${res.statusCode}`);
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                this.connected = true;
                resolve();

                res.on('data', (chunk) => {
                    const now = performance.now();
                    this.messageCount++;
                    this.lastMessageTime = now;
                    
                    const timeSinceStart = Math.round(now - this.startTime);
                    const timeSinceLastMessage = this.lastMessageTime ? Math.round(now - this.lastMessageTime) : 0;
                    
                    console.log(`[Client-${this.clientId}] Message #${this.messageCount} received - Time: ${timeSinceStart}ms, Gap: ${timeSinceLastMessage}ms, Size: ${chunk.length} bytes`);
                    
                    try {
                        const data = chunk.toString().trim();
                        if (data) {
                            const parsed = JSON.parse(data);
                            console.log(`[Client-${this.clientId}] Parsed message - References: ${parsed.references?.length || 0}, Bookmark: ${parsed.bookmark?.substring(0, 8) || 'none'}...`);
                        }
                    } catch (error) {
                        console.warn(`[Client-${this.clientId}] Failed to parse message: ${error.message}`);
                    }
                });

                res.on('end', () => {
                    const duration = Math.round(performance.now() - this.startTime);
                    console.log(`[Client-${this.clientId}] Stream ended - Duration: ${duration}ms, Messages: ${this.messageCount}`);
                    this.connected = false;
                });

                res.on('error', (error) => {
                    console.error(`[Client-${this.clientId}] Stream error: ${error.message}`);
                    this.connected = false;
                });
            });

            req.on('error', (error) => {
                console.error(`[Client-${this.clientId}] Request error: ${error.message}`);
                reject(error);
            });

            req.setTimeout(CONNECTION_DURATION + 5000, () => {
                console.log(`[Client-${this.clientId}] Request timeout`);
                req.destroy();
            });

            req.end();

            // Auto-disconnect after specified duration
            setTimeout(() => {
                if (this.connected) {
                    console.log(`[Client-${this.clientId}] Auto-disconnecting after ${CONNECTION_DURATION}ms`);
                    req.destroy();
                }
            }, CONNECTION_DURATION);
        });
    }

    getStats() {
        const duration = this.startTime ? Math.round(performance.now() - this.startTime) : 0;
        return {
            clientId: this.clientId,
            messageCount: this.messageCount,
            connected: this.connected,
            duration: duration
        };
    }
}

async function runConcurrentTest() {
    console.log(`Starting concurrent streaming test with ${NUM_CLIENTS} clients`);
    console.log(`Server: ${SERVER_HOST}:${SERVER_PORT}`);
    console.log(`Feed Hash: ${FEED_HASH}`);
    console.log(`Connection Duration: ${CONNECTION_DURATION}ms`);
    console.log(`Stagger Delay: ${STAGGER_DELAY}ms`);
    console.log('---');

    const clients = [];
    const connectionPromises = [];

    // Create and connect clients with staggered timing
    for (let i = 1; i <= NUM_CLIENTS; i++) {
        const client = new StreamingClient(i, FEED_HASH);
        clients.push(client);

        // Stagger the connections
        setTimeout(async () => {
            try {
                await client.connect();
            } catch (error) {
                console.error(`[Client-${i}] Connection failed: ${error.message}`);
            }
        }, (i - 1) * STAGGER_DELAY);
    }

    // Monitor client statistics
    const statsInterval = setInterval(() => {
        console.log('\n=== CLIENT STATISTICS ===');
        clients.forEach(client => {
            const stats = client.getStats();
            console.log(`Client-${stats.clientId}: Messages=${stats.messageCount}, Connected=${stats.connected}, Duration=${stats.duration}ms`);
        });
        console.log('========================\n');
    }, 10000); // Every 10 seconds

    // Wait for test completion
    setTimeout(() => {
        clearInterval(statsInterval);
        
        console.log('\n=== FINAL STATISTICS ===');
        let totalMessages = 0;
        let connectedClients = 0;
        
        clients.forEach(client => {
            const stats = client.getStats();
            totalMessages += stats.messageCount;
            if (stats.connected) connectedClients++;
            console.log(`Client-${stats.clientId}: Messages=${stats.messageCount}, Connected=${stats.connected}, Duration=${stats.duration}ms`);
        });
        
        console.log(`\nSummary:`);
        console.log(`- Total Messages Received: ${totalMessages}`);
        console.log(`- Still Connected: ${connectedClients}/${NUM_CLIENTS}`);
        console.log(`- Average Messages per Client: ${(totalMessages / NUM_CLIENTS).toFixed(1)}`);
        
        // Check for potential issues
        const messageCounts = clients.map(c => c.getStats().messageCount);
        const minMessages = Math.min(...messageCounts);
        const maxMessages = Math.max(...messageCounts);
        const variance = maxMessages - minMessages;
        
        if (variance > 5) {
            console.log(`\n⚠️  POTENTIAL ISSUE DETECTED:`);
            console.log(`   Message count variance: ${variance} (min: ${minMessages}, max: ${maxMessages})`);
            console.log(`   This suggests some clients may not be receiving all notifications`);
        } else {
            console.log(`\n✅ Message distribution appears consistent`);
        }
        
        console.log('\nTest completed. Check server logs for detailed diagnostic information.');
        process.exit(0);
    }, CONNECTION_DURATION + (NUM_CLIENTS * STAGGER_DELAY) + 5000);
}

// Handle command line arguments
if (process.argv.length > 2) {
    const feedHash = process.argv[2];
    if (feedHash && feedHash !== 'your-feed-hash-here') {
        FEED_HASH = feedHash;
        console.log(`Using feed hash from command line: ${FEED_HASH}`);
    }
}

if (FEED_HASH === 'your-feed-hash-here') {
    console.error('Please provide a valid feed hash as a command line argument:');
    console.error('node test-concurrent-streams.js <feed-hash>');
    console.error('\nOr edit the FEED_HASH constant in this script.');
    process.exit(1);
}

// Start the test
runConcurrentTest().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});