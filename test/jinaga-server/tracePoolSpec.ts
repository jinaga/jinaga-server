import { EventEmitter } from "events";
import { Trace, Tracer } from "jinaga";
import { Pool } from "pg";

import { tracePool } from "../../src/jinaga-server";

const windowMilliseconds = 10000;

// Jest's own fake timers cannot be installed on this version of Node, because
// they try to replace the read-only global `performance`. These stand in for
// the interval timer alone, which is all tracePool schedules, and they record
// whether it was unreferenced and whether it was cleared.
class FakeInterval {
    public dueAt: number;
    public cleared = false;
    private referenced = true;

    constructor(
        private readonly callback: () => void,
        public readonly delay: number,
        now: number
    ) {
        this.dueAt = now + delay;
    }

    ref(): this {
        this.referenced = true;
        return this;
    }

    unref(): this {
        this.referenced = false;
        return this;
    }

    hasRef(): boolean {
        return this.referenced;
    }

    fire() {
        this.callback();
    }
}

class FakeClock {
    private now = 0;
    private readonly created: FakeInterval[] = [];

    install() {
        jest.spyOn(global, 'setInterval').mockImplementation(((callback: () => void, delay?: number) => {
            const interval = new FakeInterval(callback, delay ?? 0, this.now);
            this.created.push(interval);
            return interval;
        }) as any);
        jest.spyOn(global, 'clearInterval').mockImplementation(((handle: FakeInterval) => {
            handle.cleared = true;
        }) as any);
    }

    advance(milliseconds: number) {
        const end = this.now + milliseconds;
        for (;;) {
            const due = this.live()
                .filter(interval => interval.dueAt <= end)
                .sort((a, b) => a.dueAt - b.dueAt)[0];
            if (!due) {
                break;
            }
            this.now = due.dueAt;
            due.dueAt = this.now + due.delay;
            due.fire();
        }
        this.now = end;
    }

    live(): FakeInterval[] {
        return this.created.filter(interval => !interval.cleared);
    }

    only(): FakeInterval {
        expect(this.created).toHaveLength(1);
        return this.created[0];
    }
}

interface Counts {
    total: number;
    idle: number;
    waiting: number;
}

interface MetricLine {
    message: string;
    measurements: { [key: string]: number };
}

class RecordingTracer implements Tracer {
    public readonly info_: string[] = [];
    public readonly warnings: string[] = [];
    public readonly errors: any[] = [];
    public readonly metrics: MetricLine[] = [];

    info(message: string): void {
        this.info_.push(message);
    }

    warn(message: string): void {
        this.warnings.push(message);
    }

    error(error: any): void {
        this.errors.push(error);
    }

    dependency<T>(name: string, data: string, operation: () => Promise<T>): Promise<T> {
        return operation();
    }

    metric(message: string, measurements: { [key: string]: number }): void {
        this.metrics.push({ message, measurements });
    }

    counter(name: string, value: number): void {
    }

    linesNamed(message: string): MetricLine[] {
        return this.metrics.filter(m => m.message === message);
    }
}

// Stands in for a pg Pool. It reports the counts a test chooses and emits the
// events a real pool emits, so tracePool can be driven through a storm without
// a database.
class PoolDouble extends EventEmitter {
    public totalCount = 0;
    public idleCount = 0;
    public waitingCount = 0;
    public ended = false;

    asPool(): Pool {
        return this as unknown as Pool;
    }

    acquire(counts: Counts) {
        this.report(counts);
        this.emit('acquire', {});
    }

    release(counts: Counts) {
        this.report(counts);
        this.emit('release', undefined, {});
    }

    connect(counts: Counts) {
        this.report(counts);
        this.emit('connect', {});
    }

    remove(counts: Counts) {
        this.report(counts);
        this.emit('remove', {});
    }

    fail(error: Error) {
        this.emit('error', error, {});
    }

    private report(counts: Counts) {
        this.totalCount = counts.total;
        this.idleCount = counts.idle;
        this.waitingCount = counts.waiting;
    }
}

describe('tracePool', () => {
    let tracer: RecordingTracer;
    let pool: PoolDouble;
    let clock: FakeClock;

    beforeEach(() => {
        clock = new FakeClock();
        clock.install();
        tracer = new RecordingTracer();
        Trace.configure(tracer);
        pool = new PoolDouble();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Trace.off();
    });

    it('should write one line for a window of a thousand acquires', () => {
        tracePool(pool.asPool());

        for (let i = 0; i < 1000; i++) {
            pool.acquire({ total: 10, idle: 0, waiting: 0 });
            pool.release({ total: 10, idle: 1, waiting: 0 });
        }

        expect(tracer.metrics).toHaveLength(0);

        clock.advance(windowMilliseconds);

        expect(tracer.linesNamed('Postgres pool')).toHaveLength(1);
        expect(tracer.metrics).toHaveLength(1);
    });

    it('should write no line per acquire', () => {
        tracePool(pool.asPool());

        pool.acquire({ total: 10, idle: 0, waiting: 0 });
        pool.acquire({ total: 10, idle: 0, waiting: 1 });

        expect(tracer.metrics).toHaveLength(0);
        expect(tracer.linesNamed('Postgres acquired')).toHaveLength(0);

        clock.advance(windowMilliseconds);

        expect(tracer.linesNamed('Postgres acquired')).toHaveLength(0);
    });

    it('should carry the peak waiting count of a spike that came and went', () => {
        tracePool(pool.asPool());

        pool.acquire({ total: 10, idle: 0, waiting: 0 });
        pool.acquire({ total: 10, idle: 0, waiting: 349 });
        pool.release({ total: 10, idle: 0, waiting: 120 });
        pool.release({ total: 10, idle: 3, waiting: 0 });

        clock.advance(windowMilliseconds);

        const lines = tracer.linesNamed('Postgres pool');
        expect(lines).toHaveLength(1);
        expect(lines[0].measurements).toEqual({
            total: 10,
            idle: 3,
            waiting: 0,
            peakWaiting: 349
        });
    });

    it('should warn about a window whose peak waiting count was above zero', () => {
        tracePool(pool.asPool());

        pool.acquire({ total: 10, idle: 0, waiting: 349 });
        pool.release({ total: 10, idle: 3, waiting: 0 });

        clock.advance(windowMilliseconds);

        expect(tracer.warnings).toHaveLength(1);
        expect(tracer.warnings[0]).toContain('349');
    });

    it('should not warn about a window that never had a request waiting', () => {
        tracePool(pool.asPool());

        pool.acquire({ total: 10, idle: 2, waiting: 0 });

        clock.advance(windowMilliseconds);

        expect(tracer.linesNamed('Postgres pool')).toHaveLength(1);
        expect(tracer.warnings).toHaveLength(0);
    });

    it('should write nothing for a window with no acquires', () => {
        tracePool(pool.asPool());

        clock.advance(windowMilliseconds * 3);

        expect(tracer.metrics).toHaveLength(0);
        expect(tracer.warnings).toHaveLength(0);
    });

    it('should write nothing for a window in which only a release happened', () => {
        tracePool(pool.asPool());

        pool.release({ total: 10, idle: 10, waiting: 0 });

        clock.advance(windowMilliseconds);

        expect(tracer.metrics).toHaveLength(0);
    });

    it('should report a storm that stopped in the middle of a window', () => {
        tracePool(pool.asPool());

        for (let i = 0; i < 200; i++) {
            pool.acquire({ total: 10, idle: 0, waiting: 349 });
        }
        pool.release({ total: 10, idle: 0, waiting: 0 });

        // The storm is over, and nothing touches the pool again. Only the
        // window's own close can report it.
        clock.advance(windowMilliseconds);

        const lines = tracer.linesNamed('Postgres pool');
        expect(lines).toHaveLength(1);
        expect(lines[0].measurements.peakWaiting).toBe(349);

        clock.advance(windowMilliseconds * 2);

        expect(tracer.linesNamed('Postgres pool')).toHaveLength(1);
    });

    it('should start each window with a fresh peak', () => {
        tracePool(pool.asPool());

        pool.acquire({ total: 10, idle: 0, waiting: 349 });
        clock.advance(windowMilliseconds);

        pool.acquire({ total: 10, idle: 4, waiting: 0 });
        clock.advance(windowMilliseconds);

        const lines = tracer.linesNamed('Postgres pool');
        expect(lines).toHaveLength(2);
        expect(lines[0].measurements.peakWaiting).toBe(349);
        expect(lines[1].measurements.peakWaiting).toBe(0);
        expect(tracer.warnings).toHaveLength(1);
    });

    it('should not hold the process open with the timer it schedules', () => {
        tracePool(pool.asPool());

        expect(clock.only().hasRef()).toBe(false);
    });

    it('should stop reporting once the pool has ended', () => {
        tracePool(pool.asPool());

        pool.acquire({ total: 10, idle: 0, waiting: 0 });
        clock.advance(windowMilliseconds);
        expect(tracer.linesNamed('Postgres pool')).toHaveLength(1);

        pool.acquire({ total: 10, idle: 0, waiting: 0 });
        pool.ended = true;

        clock.advance(windowMilliseconds * 5);

        expect(tracer.linesNamed('Postgres pool')).toHaveLength(1);
        expect(clock.live()).toHaveLength(0);
    });

    it('should still report each physical connection as it is made and removed', () => {
        tracePool(pool.asPool());

        pool.connect({ total: 1, idle: 0, waiting: 0 });
        pool.remove({ total: 0, idle: 0, waiting: 0 });

        expect(tracer.linesNamed('Postgres connected')).toEqual([{
            message: 'Postgres connected',
            measurements: { total: 1, idle: 0, waiting: 0 }
        }]);
        expect(tracer.linesNamed('Postgres disconnected')).toEqual([{
            message: 'Postgres disconnected',
            measurements: { total: 0, idle: 0, waiting: 0 }
        }]);
    });

    it('should still report a pool error', () => {
        tracePool(pool.asPool());

        const error = new Error('connection terminated unexpectedly');
        pool.fail(error);

        expect(tracer.errors).toEqual([error]);
    });
});
