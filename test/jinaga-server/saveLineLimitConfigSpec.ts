import { JinagaServer } from "../../src/jinaga-server";

// A review of issue #169's change observed that `maxSaveLineBytes` reaches the
// line reader unscreened, so a value denoting no usable bound would disable
// the limit for every graph save. Catching it here means a misconfigured
// server fails to start rather than serving saves the limit does not govern.
describe("maxSaveLineBytes configuration", () => {
    it.each([
        ["NaN", NaN],
        ["Infinity", Infinity],
        ["zero", 0],
        ["a negative", -1],
        ["a fraction", 1.5]
    ])("refuses to create a server whose save line limit is %s", (_label, maxSaveLineBytes) => {
        expect(() => JinagaServer.create({ maxSaveLineBytes })).toThrow(RangeError);
    });

    it("creates a server at a valid save line limit", async () => {
        // The companion to the cases above: the same construction succeeds
        // once the limit is usable, so the refusals are attributable to the
        // limit and not to anything else missing from this configuration.
        const instance = JinagaServer.create({ maxSaveLineBytes: 1024 * 1024 });

        expect(instance.handler).toBeDefined();
        await instance.close();
    });

    it("creates a server when the save line limit is omitted", async () => {
        const instance = JinagaServer.create({});

        expect(instance.handler).toBeDefined();
        await instance.close();
    });
});
