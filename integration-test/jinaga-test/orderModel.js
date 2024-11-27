const { buildModel } = require("jinaga");

function createModel() {
    return buildModel(b => b
        .type(Store)
        .type(Order, x => x
            .predecessor("store", Store)
        )
        .type(Item, x => x
            .predecessor("order", Order)
            .predecessor("product", Product)
        )
        .type(OrderCancelled, x => x
            .predecessor("order", Order)
        )
        .type(OrderCancelledReason, x => x
            .predecessor("orderCancelled", OrderCancelled)
        )
        .type(OrderShipped, x => x
            .predecessor("order", Order)
        )
    );
}

class Store {
    static Type = "Store";
    type = Store.Type;

    constructor(identifier) {
        this.identifier = identifier;
    }
}

class Order {
    static Type = "Order";
    type = Order.Type;

    constructor(store, createdAt) {
        this.store = store;
        this.createdAt = createdAt;
    }
}

class Product {
    static Type = "Product";
    type = Product.Type;

    constructor(store, identifier) {
        this.store = store;
        this.identifier = identifier;
    }
}

class Item {
    static Type = "Order.Item";
    type = Item.Type;

    constructor(order, product, quantity) {
        this.order = order;
        this.product = product;
        this.quantity = quantity;
    }
}

class OrderCancelled {
    static Type = "Order.Cancelled";
    type = OrderCancelled.Type;

    constructor(order, cancelledAt) {
        this.order = order;
        this.cancelledAt = cancelledAt;
    }
}

class OrderCancelledReason {
    static Type = "Order.Cancelled.Reason";
    type = OrderCancelledReason.Type;

    constructor(orderCancelled, reason) {
        this.orderCancelled = orderCancelled;
        this.reason = reason;
    }
}

class OrderShipped {
    static Type = "Order.Shipped";
    type = OrderShipped.Type;

    constructor(order, shippedAt) {
        this.order = order;
        this.shippedAt = shippedAt;
    }
}

module.exports = {
    createModel,
    Store,
    Order,
    Product,
    Item,
    OrderCancelled,
    OrderCancelledReason,
    OrderShipped
};
