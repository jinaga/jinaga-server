import { Trace, TraceLevel } from "jinaga";

import { JinagaServer } from "../../src/jinaga-server";

describe("LOG_LEVEL", () => {
    let savedVariable: string | undefined;
    let savedLevel: TraceLevel;

    beforeEach(() => {
        savedVariable = process.env.LOG_LEVEL;
        delete process.env.LOG_LEVEL;
        savedLevel = Trace.getLevel();
    });

    afterEach(() => {
        if (savedVariable === undefined) {
            delete process.env.LOG_LEVEL;
        }
        else {
            process.env.LOG_LEVEL = savedVariable;
        }
        Trace.setLevel(savedLevel);
    });

    // No pgStore, so create builds a memory store and no pool.
    function create() {
        return JinagaServer.create({});
    }

    it.each<TraceLevel>(["debug", "info", "warn", "error"])("sets the trace level to %s", (level) => {
        // Start from a different level, so the assertion cannot pass by
        // leaving the threshold where it already was.
        Trace.setLevel(level === "error" ? "debug" : "error");
        process.env.LOG_LEVEL = level;

        create();

        expect(Trace.getLevel()).toBe(level);
    });

    it("ignores whitespace around the level", () => {
        process.env.LOG_LEVEL = " debug ";

        create();

        expect(Trace.getLevel()).toBe("debug");
    });

    it("leaves a level the caller set alone when LOG_LEVEL is unset", () => {
        Trace.setLevel("warn");

        create();

        expect(Trace.getLevel()).toBe("warn");
    });

    it("leaves a level the caller set alone when LOG_LEVEL is empty", () => {
        Trace.setLevel("warn");
        process.env.LOG_LEVEL = "";

        create();

        expect(Trace.getLevel()).toBe("warn");
    });

    it.each(["verbose", "DEBUG"])("refuses LOG_LEVEL=%s, naming the variable and the value", (value) => {
        process.env.LOG_LEVEL = value;

        expect(create).toThrow(/LOG_LEVEL/);
        expect(create).toThrow(new RegExp(`"${value}"`));
    });

    it("leaves the level unchanged when it refuses a value", () => {
        Trace.setLevel("warn");
        process.env.LOG_LEVEL = "verbose";

        expect(create).toThrow();
        expect(Trace.getLevel()).toBe("warn");
    });
});
