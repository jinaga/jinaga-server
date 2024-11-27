const { JinagaServer } = require("./jinaga-server");
const { createModel, Item, Order, OrderCancelled, OrderCancelledReason, Product, Store } = require("./orderModel");

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

const model = createModel();

describe("After-the-fact purge", () => {
    let jInit, jPurge;
    let closeInit, closePurge;

    beforeEach(() => {
        ({ j: jInit, close: closeInit } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore:    connectionString
        }));

        ({ j: jPurge, close: closePurge } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore:    connectionString,
            purgeConditions: p => p
                .whenExists(model.given(Order).match((order, facts) => facts.ofType(OrderCancelled)
                    .join(orderCancelled => orderCancelled.order, order)
                ))
        }));
    });

    afterEach(async () => {
        await closeInit();
        await closePurge();
    });

    it("Should find descendants if purge condition is not met", async () => {
        const store = await jInit.fact(new Store("storeId"));
        const order = await jInit.fact(new Order(store, new Date()));
        const item1 = await jInit.fact(new Item(order, new Product(store, "product1"), 1));
        const item2 = await jInit.fact(new Item(order, new Product(store, "product2"), 1));

        const itemsInOrder = model.given(Order).match(order =>
            order.successors(Item, item => item.order)
        );

        await jPurge.purge();
        const items = await jPurge.query(itemsInOrder, order);
        expect(items).toEqual([item1, item2]);
    });

    it("Should purge descendants when condition is met", async () => {
        const store = await jInit.fact(new Store("storeId"));
        const order = await jInit.fact(new Order(store, new Date()));
        const item1 = await jInit.fact(new Item(order, new Product(store, "product1"), 1));
        const item2 = await jInit.fact(new Item(order, new Product(store, "product2"), 1));
        const orderCancelled = await jInit.fact(new OrderCancelled(order, new Date()));

        const itemsInOrder = model.given(Order).match(order =>
            order.successors(Item, item => item.order)
        );

        await jPurge.purge();
        const items = await jPurge.query(itemsInOrder, order);
        expect(items).toEqual([]);
    });

    it("Should not purge the trigger fact", async () => {
        const store = await jInit.fact(new Store("storeId"));
        const order = await jInit.fact(new Order(store, new Date()));
        const item1 = await jInit.fact(new Item(order, new Product(store, "product1"), 1));
        const item2 = await jInit.fact(new Item(order, new Product(store, "product2"), 1));
        const orderCancelled = await jInit.fact(new OrderCancelled(order, new Date()));

        const cancelOfOrder = model.given(Order).match(order =>
            order.successors(OrderCancelled, cancelled => cancelled.order)
        );

        await jPurge.purge();
        const cancels = await jPurge.query(cancelOfOrder, order);
        expect(cancels).toEqual([orderCancelled]);
    });
});

describe("Real-time purge", () => {
    let j;
    let close;

    beforeEach(() => {
        ({ j, close } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore:    connectionString,
            purgeConditions: p => p
                .whenExists(model.given(Order).match((order, facts) => facts.ofType(OrderCancelled)
                    .join(orderCancelled => orderCancelled.order, order)
                ))
        }));
    });

    afterEach(async () => {
        await close();
    });

    it("Should find descendants if purge condition is not met", async () => {
        const store = await j.fact(new Store("storeId"));
        const order = await j.fact(new Order(store, new Date()));
        const item1 = await j.fact(new Item(order, new Product(store, "product1"), 1));
        const item2 = await j.fact(new Item(order, new Product(store, "product2"), 1));

        const itemsInOrder = model.given(Order).match(order =>
            order.successors(Item, item => item.order)
        );

        const items = await j.query(itemsInOrder, order);
        expect(items).toEqual([item1, item2]);
    });

    it("Should purge descendants when condition is met", async () => {
        const store = await j.fact(new Store("storeId"));
        const order = await j.fact(new Order(store, new Date()));
        const item1 = await j.fact(new Item(order, new Product(store, "product1"), 1));
        const item2 = await j.fact(new Item(order, new Product(store, "product2"), 1));
        const orderCancelled = await j.fact(new OrderCancelled(order, new Date()));

        const itemsInOrder = model.given(Order).match(order =>
            order.successors(Item, item => item.order)
        );

        const items = await j.query(itemsInOrder, order);
        expect(items).toEqual([]);
    });

    it("Should not purge the trigger fact", async () => {
        const store = await j.fact(new Store("storeId"));
        const order = await j.fact(new Order(store, new Date()));
        const item1 = await j.fact(new Item(order, new Product(store, "product1"), 1));
        const item2 = await j.fact(new Item(order, new Product(store, "product2"), 1));
        const orderCancelled = await j.fact(new OrderCancelled(order, new Date()));

        const cancelOfOrder = model.given(Order).match(order =>
            order.successors(OrderCancelled, cancelled => cancelled.order)
        );

        const cancels = await j.query(cancelOfOrder, order);
        expect(cancels).toEqual([orderCancelled]);
    });
});

describe("After-the-fact purge with deep trigger", () => {
    let jInit, jPurge;
    let closeInit, closePurge;

    beforeEach(() => {
        ({ j: jInit, close: closeInit } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore:    connectionString
        }));

        ({ j: jPurge, close: closePurge } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore:    connectionString,
            purgeConditions: p => p
                .whenExists(model.given(Order).match((order, facts) => facts.ofType(OrderCancelledReason)
                    .join(orderCancelledReason => orderCancelledReason.orderCancelled.order, order)
                ))
        }));
    });

    afterEach(async () => {
        await closeInit();
        await closePurge();
    });

    it("Should not purge ancestors of the trigger fact", async () => {
        const store = await jInit.fact(new Store("storeId"));
        const order = await jInit.fact(new Order(store, new Date()));
        const item1 = await jInit.fact(new Item(order, new Product(store, "product1"), 1));
        const item2 = await jInit.fact(new Item(order, new Product(store, "product2"), 1));
        const orderCancelled = await jInit.fact(new OrderCancelled(order, new Date()));
        const reason = await jInit.fact(new OrderCancelledReason(orderCancelled, "reason"));

        const cancelOfOrder = model.given(Order).match(order =>
            order.successors(OrderCancelled, cancelled => cancelled.order)
        );

        await jPurge.purge();
        const cancels = await jPurge.query(cancelOfOrder, order);
        expect(cancels).toEqual([orderCancelled]);
    });
});

describe("Real-time purge with deep trigger", () => {
    let j;
    let close;

    beforeEach(() => {
        ({ j, close } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore:    connectionString,
            purgeConditions: p => p
                .whenExists(model.given(Order).match((order, facts) => facts.ofType(OrderCancelledReason)
                    .join(orderCancelledReason => orderCancelledReason.orderCancelled.order, order)
                ))
        }));
    });

    afterEach(async () => {
        await close();
    });

    it("Should not purge ancestors of the trigger fact", async () => {
        const store = await j.fact(new Store("storeId"));
        const order = await j.fact(new Order(store, new Date()));
        const item1 = await j.fact(new Item(order, new Product(store, "product1"), 1));
        const item2 = await j.fact(new Item(order, new Product(store, "product2"), 1));
        const orderCancelled = await j.fact(new OrderCancelled(order, new Date()));
        const reason = await j.fact(new OrderCancelledReason(orderCancelled, "reason"));

        const cancelOfOrder = model.given(Order).match(order =>
            order.successors(OrderCancelled, cancelled => cancelled.order)
        );

        const cancels = await j.query(cancelOfOrder, order);
        expect(cancels).toEqual([orderCancelled]);
    });
});