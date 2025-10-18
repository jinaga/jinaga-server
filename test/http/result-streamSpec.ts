import { AsyncIterableResultStream, arrayToResultStream, ResultStream } from '../../src/http/result-stream';

describe('ResultStream', () => {
    describe('AsyncIterableResultStream', () => {
        it('should return items sequentially', async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
            }

            const stream = new AsyncIterableResultStream(generator());

            expect(await stream.next()).toBe(1);
            expect(await stream.next()).toBe(2);
            expect(await stream.next()).toBe(3);
            expect(await stream.next()).toBeNull();
        });

        it('should return null when exhausted', async () => {
            async function* generator() {
                yield 'item';
            }

            const stream = new AsyncIterableResultStream(generator());

            expect(await stream.next()).toBe('item');
            expect(await stream.next()).toBeNull();
            expect(await stream.next()).toBeNull(); // Should still return null
        });

        it('should stop iteration after close()', async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
            }

            const stream = new AsyncIterableResultStream(generator());

            expect(await stream.next()).toBe(1);
            await stream.close();
            expect(await stream.next()).toBeNull();
            expect(await stream.next()).toBeNull();
        });

        it('should handle close() being called multiple times', async () => {
            async function* generator() {
                yield 1;
            }

            const stream = new AsyncIterableResultStream(generator());

            await stream.close();
            await stream.close(); // Should not throw
            expect(await stream.next()).toBeNull();
        });

        it('should handle empty stream', async () => {
            async function* generator() {
                // Empty generator
            }

            const stream = new AsyncIterableResultStream(generator());

            expect(await stream.next()).toBeNull();
        });
    });

    describe('arrayToResultStream', () => {
        it('should convert array to working stream', async () => {
            const array = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            const stream = arrayToResultStream(array);

            const results: number[] = [];
            let item;
            while ((item = await stream.next()) !== null) {
                results.push(item);
            }

            expect(results).toEqual(array);
            expect(results.length).toBe(10);
        });

        it('should yield all items in order', async () => {
            const array = ['first', 'second', 'third'];
            const stream = arrayToResultStream(array);

            expect(await stream.next()).toBe('first');
            expect(await stream.next()).toBe('second');
            expect(await stream.next()).toBe('third');
            expect(await stream.next()).toBeNull();
        });

        it('should handle empty array', async () => {
            const stream = arrayToResultStream([]);

            expect(await stream.next()).toBeNull();
        });

        it('should handle array with objects', async () => {
            const array = [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' }
            ];
            const stream = arrayToResultStream(array);

            const first = await stream.next();
            expect(first).toEqual({ id: 1, name: 'Alice' });

            const second = await stream.next();
            expect(second).toEqual({ id: 2, name: 'Bob' });

            expect(await stream.next()).toBeNull();
        });

        it('should allow early termination with close()', async () => {
            const array = [1, 2, 3, 4, 5];
            const stream = arrayToResultStream(array);

            expect(await stream.next()).toBe(1);
            expect(await stream.next()).toBe(2);
            
            await stream.close();
            
            expect(await stream.next()).toBeNull();
        });
    });

    describe('Stream cleanup', () => {
        it('should call iterator.return() on close', async () => {
            let returnCalled = false;

            async function* generator() {
                try {
                    yield 1;
                    yield 2;
                } finally {
                    returnCalled = true;
                }
            }

            const stream = new AsyncIterableResultStream(generator());

            await stream.next(); // Get first item
            await stream.close();

            expect(returnCalled).toBe(true);
        });
    });
});
