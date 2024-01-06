const { encode } = require("@stablelib/base64");
const { ensure, Jinaga, buildModel, Device, User, UserName } = require("jinaga");
const { JinagaServer } = require("./jinaga-server");

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

class Root {
    static Type = "IntegrationTest.Root";
    type = Root.Type;

    constructor(identifier) {
        this.identifier = identifier;
    }
}

class Successor {
    static Type = "IntegrationTest.Successor";
    type = Successor.Type;

    constructor(identifier, predecessor) {
        this.identifier = identifier;
        this.predecessor = predecessor;
    }
}

class UnknownType {
    static Type = "IntegrationTest.UnknownType";
    type = UnknownType.Type;

    constructor(predecessor) {
        this.predecessor = predecessor;
    }
}

class Configuration {
    static Type = "Configuration";
    type = Configuration.Type;

    constructor(from) {
        this.from = from;
    }
}

class Tenant {
    static Type = "MyApplication.Tenant";
    type = Tenant.Type;

    constructor(identifier, creator) {
        this.identifier = identifier;
        this.creator = creator;
    }
}

class DefaultTenant {
    static Type = "MyApplication.DefaultTenant";
    type = DefaultTenant.Type;

    constructor(tenant, device, prior) {
        this.tenant = tenant;
        this.device = device;
        this.prior = prior;
    }
}

class Membership {
    static Type = "MyApplication.Membership";
    type = Membership.Type;

    constructor(tenant, creator) {
        this.tenant = tenant;
        this.creator = creator;
    }
}

class MembershipDeleted {
    static Type = "MyApplication.Membership.Deleted";
    type = MembershipDeleted.Type;

    constructor(membership) {
        this.membership = membership;
    }
}

class MembershipRestored {
    static Type = "MyApplication.Membership.Restored";
    type = MembershipRestored.Type;

    constructor(deleted) {
        this.deleted = deleted;
    }
}

const model = buildModel(b => b
    .type(Root)
    .type(Successor, m => m
        .predecessor("predecessor", Root)
    )
    .type(UnknownType, m => m
        .predecessor("predecessor", Root)
    )
    .type(User)
    .type(UserName, m => m
        .predecessor("user", User)
        .predecessor("prior", UserName)
    )
    .type(Device)
    .type(Configuration, m => m
        .predecessor("from", Device)
    )
    .type(Tenant, m => m
        .predecessor("creator", User)
    )
    .type(DefaultTenant, m => m
        .predecessor("tenant", Tenant)
        .predecessor("device", Device)
        .predecessor("prior", DefaultTenant)
    )
    .type(Membership, m => m
        .predecessor("tenant", Tenant)
        .predecessor("creator", User)
    )
    .type(MembershipDeleted, m => m
        .predecessor("membership", Membership)
    )
    .type(MembershipRestored, m => m
        .predecessor("deleted", MembershipDeleted)
    )
);

function randomRoot() {
    const num = Math.random();
    const identifier = encode(num);

    return {
        type: "IntegrationTest.Root",
        identifier
    };
}

const successorsOfRoot = model.given(Root).match((root, facts) =>
    facts.ofType(Successor)
        .join(s => s.predecessor, root)
);

const unknownOfRoot = model.given(Root).match((root, facts) =>
    facts.ofType(UnknownType)
        .join(s => s.predecessor, root)
);

const configurationFromDevice = model.given(Device).match((device, facts) =>
    facts.ofType(Configuration)
        .join(s => s.from, device)
);

const namesOfUser = model.given(User).match((user, facts) =>
    facts.ofType(UserName)
        .join(name => name.user, user)
        .notExists(name => facts.ofType(UserName)
            .join(next => next.prior, name)
        )
);

const defaultTenantsOfDevice = model.given(Device).match((device, facts) =>
    facts.ofType(DefaultTenant)
        .join(defaultTenant => defaultTenant.device, device)
        .notExists(defaultTenant => facts.ofType(DefaultTenant)
            .join(next => next.prior, defaultTenant)
        )
);

const membershipsForUser = model.given(User).match((user, facts) =>
    facts.ofType(Membership)
        .join(membership => membership.creator, user)
        .notExists(membership => facts.ofType(MembershipDeleted)
            .join(deleted => deleted.membership, membership)
            .notExists(deleted => facts.ofType(MembershipRestored)
                .join(restored => restored.deleted, deleted)
            )
        )
);

async function check(callback) {
    const { j, close } = JinagaServer.create({
        pgKeystore: connectionString,
        pgStore:    connectionString
    });

    try {
        await callback(j);
    }
    finally {
        await close();
    }
}

function authorization(a) {
    return a
        .type(UserName, n => n.user)
        .type(Tenant, t => t.creator)
        .type(DefaultTenant, t => t.tenant.creator)
        .type(Membership, m => m.tenant.creator)
        .type(MembershipDeleted, d => d.membership.tenant.creator)
        .type(MembershipRestored, r => r.deleted.membership.tenant.creator)
        ;
}

describe("Jinaga as a device", () => {
    let j;
    let close;

    beforeEach(async () => {
        ({ j, close } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore:    connectionString
        }));
        await j.local();
    });

    afterEach(async () => {
        await close();
    });

    it("should save a fact", async () => {
        const root = await j.fact(randomRoot());

        expect(root.type).toEqual("IntegrationTest.Root");
    });

    it("should save a fact twice", async () => {
        const root = randomRoot();
        await j.fact(root);
        await j.fact(root);

        expect(root.type).toEqual("IntegrationTest.Root");
    });

    it("should save a successor fact", async () => {
        const root = await j.fact(randomRoot());

        const successor = await j.fact(new Successor("test-successor", root));

        expect(successor.identifier).toEqual("test-successor");
        expect(successor.predecessor).toEqual(root);
    });

    it("should query a successor fact", async () => {
        const root = await j.fact(randomRoot());

        const successor = await j.fact(new Successor("test-successor", root));
        const successors = await j.query(successorsOfRoot, root);

        expect(successors).toEqual([successor]);
    })

    it("should query a type that has never been seen", async () => {
        const root = await j.fact(randomRoot());
        const unknown = await j.query(unknownOfRoot, root);

        expect(unknown).toEqual([]);
    });

    it("should save a successor fact twice", async () => {
        const root = await j.fact(randomRoot());

        await j.fact(new Successor("test-successor", root));
        const successor = await j.fact(new Successor("test-successor", root));

        expect(successor.identifier).toEqual("test-successor");
        expect(successor.predecessor).toEqual(root);
    });


    it("should save multiple facts", async () => {
        const successor = await j.fact(new Successor("test-successor", randomRoot()));

        expect(successor.identifier).toEqual("test-successor");
        expect(successor.predecessor.type).toEqual("IntegrationTest.Root");
    });

    it("should get the device identity", async () => {
        const device = await j.local();

        expect(device.type).toEqual("Jinaga.Device");
    });

    it("should get device information", async () => {
        const device = await j.local();

        await j.fact(new Configuration(device));

        await check(async j => {
            const checkDevice = await j.local();
            expect(checkDevice).toEqual(device);

            const configurations = await j.query(configurationFromDevice, checkDevice);

            expect(configurations.length).toEqual(1);
            expect(configurations[0].type).toEqual("Configuration");
            expect(configurations[0].from.type).toEqual("Jinaga.Device");
            expect(configurations[0].from.publicKey).toEqual(checkDevice.publicKey);
        });
    });
});

describe("Jinaga as a user", () => {
    let j;
    let jDevice;
    let close;
    let done;
    let session;

    beforeEach(() => {
        const promise = new Promise((resolve) => {
            done = resolve;
        });
        ({ j: jDevice, close, withSession } = JinagaServer.create({
            model,
            pgKeystore: connectionString,
            pgStore:    connectionString,
            authorization
        }));
        session = withSession({ user: {
            provider: "test",
            id: "test-user",
            profile: {
                displayName: "Test User"
            }
        } }, async jUser => {
            j = jUser;
            await promise;
        });
    });

    afterEach(async () => {
        done();
        await session;
        await close();
    });

    it("should get the user identity", async () => {
        const user = await j.login();

        expect(user.userFact.type).toEqual("Jinaga.User");
    });

    it("should not allow an unauthorized fact", async () => {
        try {
            await j.fact({
                type: "IntegrationTest.Unauthorized",
                identifier: "test-unauthorized"
            });
            throw new Error("Expected fact to be rejected");
        }
        catch (e) {
            expect(e.message).toEqual("Rejected 1 fact of type IntegrationTest.Unauthorized.");
        }
    });

    it("should save user name", async () => {
        const { userFact: user, profile } = await j.login();

        const userName = new UserName([], user, profile.displayName);
        await j.fact(userName);

        const userNames = await jDevice.query(namesOfUser, user);

        expect(userNames.length).toEqual(1);
        expect(userNames[0].value).toEqual("Test User");
    });

    it("should set default tenant", async () => {
        const { userFact: user } = await j.login();
        const device = await j.local();

        const defaultTenant = await j.fact(new DefaultTenant(
            new Tenant("test-tenant", user),
            device,
            []
        ));

        const defaultTenants = await jDevice.query(defaultTenantsOfDevice, device);
        expect(defaultTenants).toEqual([defaultTenant]);
    });

    it("should find no memberships", async () => {
        const { userFact: user } = await j.login();

        const memberships = await j.query(membershipsForUser, user);
        expect(memberships).toEqual([]);
    });

    it("should find assigned membership", async () => {
        const { userFact: user } = await j.login();

        const membership = await j.fact(new Membership(
            new Tenant("test-tenant", user),
            user
        ));

        const memberships = await j.query(membershipsForUser, user);
        expect(memberships).toEqual([membership]);
    });

    it("should not find deleted membership", async () => {
        const { userFact: user } = await j.login();

        const membership = await j.fact(new Membership(
            new Tenant("test-tenant", user),
            user
        ));
        await j.fact(new MembershipDeleted(membership));

        const memberships = await j.query(membershipsForUser, user);
        expect(memberships).toEqual([]);
    });

    it("should find restored membership", async () => {
        const { userFact: user } = await j.login();

        const membership = await j.fact(new Membership(
            new Tenant("test-tenant", user),
            user
        ));
        const deleted = await j.fact(new MembershipDeleted(membership));
        await j.fact(new MembershipRestored(deleted));

        const memberships = await j.query(membershipsForUser, user);
        expect(memberships).toEqual([membership]);
    });
})