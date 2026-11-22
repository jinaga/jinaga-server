/**
 * Jest's own fake timers cannot be installed on this version of Node, because
 * they try to replace the read-only global `performance`. These stand in for
 * the interval timer alone, which is all a windowed reporter schedules, and
 * they record whether it was unreferenced and whether it was cleared.
 *
 * Shared by every spec that closes a reporting window, so the windows all
 * advance the same way.
 */
export class FakeInterval {
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

export class FakeClock {
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
