import {
    canonicalPredecessors,
    FactEnvelope,
    FactFeed,
    FactRecord,
    FactReference,
    factReferenceEquals,
    FactSignature,
    FactTuple,
    getAllFactTypes,
    getAllRoles,
    PredecessorCollection,
    ProjectedResult,
    Specification,
    Storage,
    TopologicalSorter,
    Trace
} from "jinaga";
import { Pool, PoolClient } from "pg";

import { distinct, flatten } from "../util/fn";
import { ConnectionFactory, Row } from "./connection";
import { EdgeRecord, makeEdgeRecords } from "./edge-record";
import {
    addFact,
    addFactType,
    addRole,
    copyFactTypeMap,
    deepCopyRoleMap,
    emptyFactMap,
    emptyFactTypeMap,
    emptyPublicKeyMap,
    emptyRoleMap,
    ensureGetFactTypeId,
    FactMap,
    FactTypeMap,
    getFactId,
    getFactTypeId,
    getPublicKeyId,
    getRoleId,
    hasFact,
    hasRole,
    mergeFactTypes,
    mergeRoleMaps,
    PublicKeyMap,
    RoleMap
} from "./maps";
import { ResultSetFact, ResultSetRow, ResultSetTree, resultSqlFromSpecification, SqlQueryTree } from "./specification-result-sql";
import { sqlFromFeed } from "./specification-sql";
import { purgeDescendantsSql, purgeSqlFromSpecifications } from "./purge-sql";

interface PostgresFactRecord extends FactRecord {
    timestamp: Date;  // Maps to date_learned column
}

interface FactTypeResult {
    rows: {
        fact_type_id: number;
        name: string;
    }[];
}

interface RoleResult {
    rows: {
        role_id: number;
        name: string;
        defining_fact_type_id: number;
    }[];
}

interface FactResult {
    rows: {
        fact_id: number;
        fact_type_id: number;
        hash: string;
    }[];
}

interface ExistsResult {
    rows: {
        fact_type_id: number;
        hash: string;
    }[];
}

interface PublicKeyResult {
    rows: {
        public_key_id: number;
        public_key: string;
    }[];
}

interface AncestorResult {
    rows: {
        fact_type_id: number;
        name: string;
        hash: string;
        data: string;
        public_key: string;
        signature: string;
        date_learned: Date;
    }[];
}

interface SpecificationLabel {
    type: string;
    index: number;
}

function loadFactTuple(labels: SpecificationLabel[], row: Row): FactTuple {
    const facts = labels.map(label => {
        const hashColumn = `hash${label.index}`;
        const hash = row[hashColumn];
        if (hash === null) {
            const columns = Object.keys(row);
            throw new Error(`Cannot find column '${hashColumn}'. Available columns: ${columns.join(', ')}`);
        }
        const fact: FactReference = {
            type: label.type,
            hash
        }
        return fact;
    });
    const bookmark: number[] = row.bookmark;
    return {
        facts,
        bookmark: bookmark.join(".")
    };
}

/**
 * The first key of the advisory lock that serializes the saves which insert
 * facts.
 *
 * `fact.fact_id` is a `SERIAL`, so a save is given its ids when it inserts,
 * not when it commits. Two saves running at `READ COMMITTED` can therefore
 * commit out of id order: the one holding the lower id commits second, and
 * lands behind a feed bookmark that has already moved past it.
 *
 * A save takes this lock immediately before it inserts, so it cannot take an
 * id until every save holding a lower one has committed or rolled back. Ids
 * are then handed out in commit order, and no tuple can appear behind a
 * published position.
 *
 * The second key is `hashtext(lower(schema))`. The guarantee is about one
 * `fact_id` sequence, and each schema has its own, so stores on different
 * schemas of the same database have no reason to wait on each other.
 *
 * The schema is folded to lower case first because it reaches every other
 * statement as an unquoted identifier, which PostgreSQL folds the same way:
 * `public` and `PUBLIC` name one schema, so they have to key one lock. The
 * folding errs toward collision, and a collision costs the two stores that
 * share a key their concurrency, never correctness.
 *
 * The value is arbitrary. What matters is that every save, in every process
 * reaching the same schema, uses the same pair. Advisory locks occupy a
 * namespace of their own, so this cannot collide with a row or table lock.
 */
const saveFactsLockKey = 1263186513;

export class PostgresStore implements Storage {
    private connectionFactory: ConnectionFactory;
    private factTypeMap: FactTypeMap = emptyFactTypeMap();
    private roleMap: RoleMap = emptyRoleMap();
    private idOrderValidatedPromise: Promise<boolean> | null = null;

    constructor (pool: Pool, private schema: string) {
        this.connectionFactory = new ConnectionFactory(pool);
    }

    close() {
        return Promise.resolve();
    }
    
    /**
     * Save facts, assigning their ids in commit order.
     *
     * The transaction takes the save lock immediately before it inserts the
     * facts, so the saves that assign fact ids run one at a time. The lock is
     * transaction-scoped: a commit or a rollback releases it, and a save that
     * fails cannot strand the next one.
     *
     * This is what lets a feed bookmark mean "every tuple up to here". A
     * bookmark is a position in `fact_id` order, so a fact whose id is lower
     * than a position a reader has already passed would never be delivered to
     * that reader. Serializing the saves keeps that state from forming.
     *
     * Only the insert needs that guarantee. Resolving fact types, looking up
     * which facts already exist, and resolving roles assign no fact id, so
     * they run before the lock is taken, and a save whose facts all exist
     * already returns without taking it at all.
     *
     * Because the existence check no longer runs under the lock, a concurrent
     * save can insert a fact this one has just found absent. The insert then
     * violates `ux_fact`, and `ConnectionFactory` retries the whole
     * transaction on a unique violation; the next attempt's existence check
     * finds the fact and inserts nothing. That is the same race this save
     * path ran before the lock existed, and the same mechanism answers it.
     */
    async save(envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        if (envelopes.length > 0) {
            const facts = envelopes.map(e => e.fact).filter((value, index, self) =>
                 self.findIndex(factReferenceEquals(value)) === index);
            if (facts.some(f => !f.hash || !f.type)) {
                throw new Error('Attempted to save a fact with no hash or type.');
            }
            const { newEnvelopes, factTypes, roles } : {
                newEnvelopes: FactEnvelope[];
                factTypes: FactTypeMap;
                roles: RoleMap;
            } = await this.connectionFactory.withTransaction(async (connection) => {
                const factTypes = await storeFactTypes(facts, this.factTypeMap, connection, this.schema);
                const existingFacts = await findExistingFacts(facts, factTypes, connection, this.schema);
                const newFacts = sortByPredecessor(
                    facts.filter(f => !hasFact(existingFacts, f.hash, ensureGetFactTypeId(factTypes, f.type))));
                if (newFacts.length === 0) {
                    return {
                        newEnvelopes: [],
                        factTypes,
                        roles: emptyRoleMap()
                    };
                }

                // `addRole` mutates the inner map it is given and
                // `copyRoleMap` leaves those shared, so a shallow copy would
                // put a role id into the store's own map before this
                // transaction commits. A rollback would then leave an id
                // behind that names no row, and the next save through this
                // store would skip the insert and point an edge at it. The
                // ids this transaction assigns stay local until it commits
                // and `mergeRoleMaps` takes them, as in `readAsIfSaved`.
                const roles = await storeRoles(newFacts, factTypes, deepCopyRoleMap(this.roleMap), connection, this.schema);

                // Immediately before the insert, so that no save can take a
                // fact id while another save that has already taken one is
                // still open. Everything above this line assigns no fact id,
                // and a save that reaches it inserts at least one fact.
                await connection.query('SELECT pg_advisory_xact_lock($1::integer, hashtext(lower($2::text)))', [saveFactsLockKey, this.schema]);
                const allFacts = await insertFactsEdgesAndAncestors(newFacts, factTypes, existingFacts, connection, roles, this.schema);
                // For each new fact, find all of the signatures that were provided.
                const newEnvelopes = newFacts.map(fact => {
                    const predicate = factReferenceEquals(fact);
                    const signatures = envelopes
                        .filter(envelope => predicate(envelope.fact))
                        .flatMap(envelope => envelope.signatures);
                    return {
                        fact,
                        signatures
                    };
                });
                if (newEnvelopes.length === 0) {
                    return {
                        newEnvelopes,
                        factTypes,
                        roles
                    };
                }

                const publicKeys = await storePublicKeys(newEnvelopes, connection, this.schema);
                await insertSignatures(newEnvelopes, allFacts, factTypes, publicKeys, connection, this.schema);
                return {
                    newEnvelopes,
                    factTypes,
                    roles
                };
            });
            this.factTypeMap = mergeFactTypes(this.factTypeMap, factTypes);
            this.roleMap = mergeRoleMaps(this.roleMap, roles);
            return newEnvelopes;
        }
        else {
            return [];
        }
    }

    /**
     * Read the projected results of a specification.
     *
     * One read sees one graph. Every statement runs on one connection inside
     * one `REPEATABLE READ` transaction, whose snapshot is taken by its first
     * statement: the type and role lookups, the parent query, each child
     * query, and the load of the projected facts. A save that commits during
     * the read is in all of them or none of them. The graph the read returns
     * is one the store held at or after the call; feeds and inverses carry an
     * observer forward from there.
     *
     * Every id the read sees belongs to a committed row, so the fact types and
     * roles it discovers are merged into the store's caches afterwards.
     */
    async read(start: FactReference[], specification: Specification): Promise<ProjectedResult[]> {
        const { results, factTypes, roleMap } = await this.connectionFactory.with(async (connection) => {
            await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            try {
                return await this.readInSnapshot(start, specification, connection);
            }
            finally {
                await connection.query('COMMIT');
            }
        });
        this.factTypeMap = mergeFactTypes(this.factTypeMap, factTypes);
        this.roleMap = mergeRoleMaps(this.roleMap, roleMap);
        return results;
    }

    private async readInSnapshot(start: FactReference[], specification: Specification, connection: PoolClient): Promise<{
        results: ProjectedResult[];
        factTypes: FactTypeMap;
        roleMap: RoleMap;
    }> {
        const factTypes = await resolveFactTypes(getAllFactTypes(specification), this.factTypeMap, connection, this.schema);
        const roleMap = await resolveRoles(specification, factTypes, deepCopyRoleMap(this.roleMap), connection, this.schema);

        // If any of the start facts are not known types, the specification cannot be satisfied.
        if (start.filter(f => getFactTypeId(factTypes, f.type) === undefined).length > 0) {
            return { results: [], factTypes, roleMap };
        }

        const composer = resultSqlFromSpecification(start, specification, factTypes, roleMap, this.schema);
        if (composer === null) {
            return { results: [], factTypes, roleMap };
        }

        const resultSets = await executeQueryTree(composer.getSqlQueries(), connection);

        // Load the facts that the results project, with their ancestors.
        const factReferences: FactReference[] = composer.findFactReferences(resultSets);
        const projectionFactTypes = await resolveFactTypes(
            factReferences.map(r => r.type), factTypes, connection, this.schema);
        const { envelopes, discoveredFactTypes } = await loadEnvelopes(factReferences, projectionFactTypes, connection, this.schema);
        const results = composer.compose(resultSets, envelopes.map(envelope => envelope.fact));
        return {
            results,
            factTypes: mergeFactTypes(projectionFactTypes, discoveredFactTypes),
            roleMap
        };
    }

    /**
     * Read as though `staged` had been saved, without saving it.
     *
     * The staged facts are written on one connection inside one transaction
     * that is always rolled back, so the rows they add are visible to this
     * read and to nothing else.
     *
     * Every map this method touches is local to the call. A fact type or role
     * inserted here is given its id by a transaction that does not commit, so
     * an id that reached `factTypeMap` or `roleMap` would name a row that does
     * not exist. `addFactType` and `addRole` mutate the map they are given,
     * and `copyRoleMap` leaves the inner maps shared, which is why the role
     * map is copied with `deepCopyRoleMap`.
     */
    async readAsIfSaved(staged: FactEnvelope[], start: FactReference[], specification: Specification): Promise<ProjectedResult[]> {
        const facts = staged.map(e => e.fact).filter((value, index, self) =>
            self.findIndex(factReferenceEquals(value)) === index);
        if (facts.some(f => !f.hash || !f.type)) {
            throw new Error('Attempted to stage a fact with no hash or type.');
        }

        return await this.connectionFactory.with(async (connection) => {
            await connection.query('BEGIN');
            try {
                let factTypes = await storeFactTypes(facts, copyFactTypeMap(this.factTypeMap), connection, this.schema);
                let roleMap = deepCopyRoleMap(this.roleMap);
                // Only the facts this call inserts are staged. One the store
                // already held keeps its id, and stays visible everywhere.
                let stagedFactIds: number[] = [];
                if (facts.length > 0) {
                    const existingFacts = await findExistingFacts(facts, factTypes, connection, this.schema);
                    const newFacts = sortByPredecessor(
                        facts.filter(f => !hasFact(existingFacts, f.hash, ensureGetFactTypeId(factTypes, f.type))));
                    if (newFacts.length > 0) {
                        roleMap = await storeRoles(newFacts, factTypes, roleMap, connection, this.schema);
                        const allFacts = await insertFactsEdgesAndAncestors(newFacts, factTypes, existingFacts, connection, roleMap, this.schema);
                        stagedFactIds = newFacts.map(f => {
                            const factId = getFactId(allFacts, f.hash, ensureGetFactTypeId(factTypes, f.type));
                            if (factId === undefined) {
                                throw new Error(`Staged fact ${f.type} ${f.hash} was not inserted.`);
                            }
                            return factId;
                        });
                    }
                }

                factTypes = await resolveFactTypes(getAllFactTypes(specification), factTypes, connection, this.schema);
                roleMap = await resolveRoles(specification, factTypes, roleMap, connection, this.schema);

                // If any of the start facts are not known types, the specification cannot be satisfied.
                if (start.filter(f => getFactTypeId(factTypes, f.type) === undefined).length > 0) {
                    return [];
                }

                const composer = resultSqlFromSpecification(start, specification, factTypes, roleMap, this.schema, stagedFactIds);
                if (composer === null) {
                    return [];
                }

                const resultSets = await executeQueryTree(composer.getSqlQueries(), connection);
                const factReferences: FactReference[] = composer.findFactReferences(resultSets);
                const projectionFactTypes = await resolveFactTypes(
                    factReferences.map(r => r.type), factTypes, connection, this.schema);
                const { envelopes } = await loadEnvelopes(factReferences, projectionFactTypes, connection, this.schema);
                return composer.compose(resultSets, envelopes.map(envelope => envelope.fact));
            }
            finally {
                await connection.query('ROLLBACK');
            }
        });
    }

    /**
     * Reports whether the database has validated that every edge runs from a
     * lower fact id to a higher one.
     *
     * A feed page's bookmark bound can drop the branch of an output that
     * another output sits above only while that holds, so the answer comes
     * from the database's own record of it, the
     * `ck_edge_successor_after_predecessor` constraint, rather than from
     * configuration or from a second copy kept in step by hand.
     *
     * The answer is read once and held for the store's lifetime. Only DDL can
     * change it, and the repair script's DDL is transactional, so a validated
     * constraint stays validated. The first read happens on the first feed
     * because `JinagaServer.create` is synchronous and has no startup hook.
     * The promise rather than its value is cached, so concurrent first feeds
     * ask the database once.
     */
    private idOrderValidated(): Promise<boolean> {
        if (this.idOrderValidatedPromise === null) {
            this.idOrderValidatedPromise = this.readIdOrderValidated()
                .catch(reason => {
                    // A read that failed is not an answer, so it is not kept.
                    // Caching the rejection would make one unreachable moment
                    // the store's permanent state.
                    this.idOrderValidatedPromise = null;
                    throw reason;
                });
        }
        return this.idOrderValidatedPromise;
    }

    private async readIdOrderValidated(): Promise<boolean> {
        return await this.connectionFactory.with(async (connection) => {
            const { rows }: { rows: { convalidated: boolean }[] } = await connection.query(
                'SELECT convalidated FROM pg_constraint' +
                ' WHERE conname = \'ck_edge_successor_after_predecessor\'' +
                ' AND conrelid = $1::regclass',
                [`${this.schema}.edge`]);
            if (rows.length === 0) {
                Trace.warn(`The ${this.schema}.edge table has no ck_edge_successor_after_predecessor constraint, ` +
                    `so this schema predates the fact id order invariant and feed pages keep their redundant bounds. ` +
                    `Run setup.sql to add the constraint.`);
                return false;
            }
            if (!rows[0].convalidated) {
                const { rows: counts }: { rows: { violations: string }[] } = await connection.query(
                    `SELECT count(*) AS violations FROM ${this.schema}.edge` +
                    ' WHERE successor_fact_id < predecessor_fact_id');
                const violations = Number(counts[0].violations);
                Trace.warn(`The ${this.schema}.edge constraint ck_edge_successor_after_predecessor is not validated, ` +
                    `and ${violations} edge${violations === 1 ? '' : 's'} run from a higher fact id to a lower one, ` +
                    `so feed pages keep their redundant bounds. ` +
                    (violations === 0
                        ? `Run setup.sql to validate the constraint.`
                        : `Run repair-edge-order.sql to restore the order, which also validates the constraint.`));
                return false;
            }
            return true;
        });
    }

    async feed(feed: Specification, start: FactReference[], bookmark: string): Promise<FactFeed> {
        const factTypes: FactTypeMap = await this.loadFactTypesFromFeed(feed);
        const roleMap: RoleMap = await this.loadRolesFromFeed(feed, factTypes);
        const idOrderValidated = await this.idOrderValidated();
        const sql = sqlFromFeed(feed, start, this.schema, bookmark, 100, factTypes, roleMap, idOrderValidated);
        if (!sql) {
            return {
                tuples: [],
                bookmark
            };
        }

        const { rows } = await this.connectionFactory.with(async (connection) => {
            return await connection.query(sql.sql, sql.parameters);
        });
        const tuples = rows.map(row => loadFactTuple(sql.labels, row));
        return {
            tuples,
            bookmark: tuples.length > 0 ? tuples[tuples.length - 1].bookmark : bookmark
        };
    }

    async loadFactTypesFromFeed(feed: Specification): Promise<FactTypeMap> {
        const factTypes = this.factTypeMap;
        const unknownFactTypes = getAllFactTypes(feed)
            .filter(factType => !factTypes.has(factType));
        if (unknownFactTypes.length > 0) {
            const loadedFactTypes = await this.connectionFactory.with(async (connection) => {
                return await loadFactTypes(unknownFactTypes, connection, this.schema);
            });
            const merged = mergeFactTypes(this.factTypeMap, loadedFactTypes);
            this.factTypeMap = merged;
            return merged;
        }
        return factTypes;
    }

    async loadFactTypesFromSpecification(specification: Specification): Promise<FactTypeMap> {
        const factTypes = this.factTypeMap;
        const unknownFactTypes = getAllFactTypes(specification)
            .filter(factType => !factTypes.has(factType));
        if (unknownFactTypes.length > 0) {
            const loadedFactTypes = await this.connectionFactory.with(async (connection) => {
                return await loadFactTypes(unknownFactTypes, connection, this.schema);
            });
            const merged = mergeFactTypes(this.factTypeMap, loadedFactTypes);
            this.factTypeMap = merged;
            return merged;
        }
        return factTypes;
    }

    async loadRolesFromSpecification(specification: Specification, factTypes: FactTypeMap): Promise<RoleMap> {
        const roleMap = this.roleMap;
        const unknownRoles = getAllRoles(specification)
            .filter(r => getFactTypeId(factTypes, r.successorType))
            .map(r => ({
                successor_type_id: getFactTypeId(factTypes, r.successorType)!,
                role: r.name
            }))
            .filter(r => r.successor_type_id && !hasRole(roleMap, r.successor_type_id, r.role));
        if (unknownRoles.length > 0) {
            const loadedRoles = await this.connectionFactory.with(async (connection) => {
                return await loadRoles(unknownRoles, roleMap, connection, this.schema);
            });
            const merged = mergeRoleMaps(this.roleMap, loadedRoles);
            this.roleMap = merged;
            return merged;
        }
        return roleMap;
    }

    async loadRolesFromFeed(feed: Specification, factTypes: FactTypeMap): Promise<RoleMap> {
        const roleMap = this.roleMap;
        const unknownRoles = getAllRoles(feed)
            .map(r => ({
                successor_type_id: getFactTypeId(factTypes, r.successorType)!,
                role: r.name
            }))
            .filter(r => r.successor_type_id && !hasRole(roleMap, r.successor_type_id, r.role));
        if (unknownRoles.length > 0) {
            const loadedRoles = await this.connectionFactory.with(async (connection) => {
                return await loadRoles(unknownRoles, roleMap, connection, this.schema);
            });
            const merged = mergeRoleMaps(this.roleMap, loadedRoles);
            this.roleMap = merged;
            return merged;
        }
        return roleMap;
    }

    async whichExist(references: FactReference[]): Promise<FactReference[]> {
        if (references.length === 0) {
            return [];
        }

        const factTypes = await this.loadFactTypesFromReferences(references);

        const factValues = references.map((f, i) =>
            `(\$${i * 2 + 1}, \$${i * 2 + 2}::integer)`);
        const factParameters = flatten(references, (f) =>
            [f.hash, factTypes.get(f.type)]);
        const sql =
            'SELECT f.fact_type_id, f.hash ' +
            `FROM ${this.schema}.fact f ` +
            'JOIN (VALUES ' + factValues.join(', ') + ') AS v (hash, fact_type_id) ' +
            '  ON v.fact_type_id = f.fact_type_id AND v.hash = f.hash ';
        const result: ExistsResult = await this.connectionFactory.with(async (connection) => {
            return await connection.query(sql, factParameters);
        });

        const existing = references.filter(r =>
            result.rows.some(row =>
                row.fact_type_id === factTypes.get(r.type) && row.hash === r.hash
            )
        );
        return existing;
    }

    async load(references: FactReference[]): Promise<FactEnvelope[]> {
        if (references.length === 0) {
            return [];
        }

        const factTypes = await this.loadFactTypesFromReferences(references);
        const { envelopes, discoveredFactTypes } = await this.connectionFactory.with(async (connection) => {
            return await loadEnvelopes(references, factTypes, connection, this.schema);
        });
        this.factTypeMap = mergeFactTypes(this.factTypeMap, discoveredFactTypes);
        return envelopes;
    }

    private async loadFactTypesFromReferences(references: FactReference[]): Promise<FactTypeMap> {
        const factTypes = this.factTypeMap;
        const newFactTypes = references
            .map(reference => reference.type)
            .filter(type => !factTypes.has(type))
            .filter(distinct);
        if (newFactTypes.length > 0) {
            const loadedFactTypes = await this.connectionFactory.with(async (connection) => {
                return await loadFactTypes(newFactTypes, connection, this.schema);
            });
            const mergedFactTypes = mergeFactTypes(factTypes, loadedFactTypes);
            this.factTypeMap = mergedFactTypes;
            return mergedFactTypes;
        }
        return factTypes;
    }

    async purge(purgeConditions: Specification[]): Promise<number> {
        // Purge all conditions on one root type in a single statement,
        // so that no condition deletes the triggers of another.
        const conditionsByGivenType = new Map<string, Specification[]>();
        for (const specification of purgeConditions) {
            const givenType = specification.given[0].label.type;
            const group = conditionsByGivenType.get(givenType) ?? [];
            group.push(specification);
            conditionsByGivenType.set(givenType, group);
        }

        let count = 0;
        for (const specifications of conditionsByGivenType.values()) {
            let factTypes = this.factTypeMap;
            let roleMap = this.roleMap;
            for (const specification of specifications) {
                factTypes = await this.loadFactTypesFromSpecification(specification);
                roleMap = await this.loadRolesFromSpecification(specification, factTypes);
            }

            const purgeCommand = purgeSqlFromSpecifications(specifications, factTypes, roleMap, this.schema);
            if (!purgeCommand) {
                continue;
            }

            const { sql, parameters } = purgeCommand;
            var result = await this.connectionFactory.with(async (connection) => {
                return await connection.query(sql, parameters);
            });
            count += result.rowCount || 0;
        }
        return count;
    }

    async purgeDescendants(purgeRoot: FactReference, triggers: FactReference[]): Promise<number> {
        const factTypes = await this.loadFactTypesFromReferences([ purgeRoot, ...triggers ]);
        if (!factTypes.has(purgeRoot.type) || triggers.some(t => !factTypes.has(t.type))) {
            return 0;
        }

        const parameters = [
            factTypes.get(purgeRoot.type),
            purgeRoot.hash,
            ...triggers.map(t => [ factTypes.get(t.type), t.hash ]).flat()
        ];

        const purgeCommand: string = purgeDescendantsSql(triggers.length, this.schema);

        var result = await this.connectionFactory.with(async (connection) => {
            return await connection.query(purgeCommand, parameters);
        });
        return result.rowCount || 0;
    }

    async loadBookmark(feed: string): Promise<string> {
        const sql = `SELECT bookmark FROM ${this.schema}.bookmark WHERE feed = $1`;
        const result = await this.connectionFactory.with(async (connection) => {
            return await connection.query(sql, [feed]);
        });
        if (result.rows.length === 0) {
            return "";
        }
        return result.rows[0].bookmark;
    }

    async saveBookmark(feed: string, bookmark: string): Promise<void> {
        const sql = `
            INSERT INTO ${this.schema}.bookmark (feed, bookmark)
            VALUES ($1, $2)
            ON CONFLICT (feed) DO UPDATE SET bookmark = EXCLUDED.bookmark
        `;
        await this.connectionFactory.with(async (connection) => {
            await connection.query(sql, [feed, bookmark]);
        });
    }

    getMruDate(specificationHash: string): Promise<Date | null> {
        return Promise.resolve(null);
    }
    
    setMruDate(specificationHash: string, mruDate: Date): Promise<void> {
        return Promise.resolve();
    }
}

/**
 * Load the given references, and their ancestors, on one connection.
 *
 * The caller supplies the fact type map and decides what to do with the types
 * the rows reveal, so a caller reading inside an uncommitted transaction can
 * keep those ids out of the store's caches.
 */
async function loadEnvelopes(references: FactReference[], factTypes: FactTypeMap, connection: PoolClient, schema: string): Promise<{
    envelopes: FactEnvelope[];
    discoveredFactTypes: FactTypeMap;
}> {
    if (references.length === 0) {
        return { envelopes: [], discoveredFactTypes: emptyFactTypeMap() };
    }

    const factValues = references.map((f, i) =>
        `(\$${i * 2 + 1}, \$${i * 2 + 2}::integer)`);
    const factParameters = flatten(references, (f) =>
        [f.hash, factTypes.get(f.type)]);
    const sql =
        'SELECT f.fact_type_id, f.name, f.hash, f.data, f.date_learned, s.public_key, s.signature ' +
        'FROM (SELECT f.fact_id, f.fact_type_id, t.name, f.hash, f.data, f.date_learned ' +
            `FROM ${schema}.fact f ` +
            `JOIN ${schema}.fact_type t ` +
            '  ON f.fact_type_id = t.fact_type_id ' +
            'JOIN (VALUES ' + factValues.join(', ') + ') AS v (hash, fact_type_id) ' +
            '  ON v.fact_type_id = f.fact_type_id AND v.hash = f.hash ' +
            'UNION ' +
            'SELECT f2.fact_id, f2.fact_type_id, t.name, f2.hash, f2.data, f2.date_learned ' +
            `FROM ${schema}.fact f1 ` +
            'JOIN (VALUES ' + factValues.join(', ') + ') AS v (hash, fact_type_id) ' +
            '  ON v.fact_type_id = f1.fact_type_id AND v.hash = f1.hash ' +
            `JOIN ${schema}.ancestor a ` +
            '  ON a.fact_id = f1.fact_id ' +
            `JOIN ${schema}.fact f2 ` +
            '  ON f2.fact_id = a.ancestor_fact_id ' +
            `JOIN ${schema}.fact_type t ` +
            '  ON t.fact_type_id = f2.fact_type_id) as f ' +
        'LEFT JOIN (SELECT p.public_key, s.signature, s.fact_id ' +
            `FROM ${schema}.signature s ` +
            `JOIN ${schema}.public_key p ` +
            '  ON p.public_key_id = s.public_key_id) as s ' +
        'ON s.fact_id = f.fact_id ' +
        'ORDER BY f.fact_id, s.public_key;';
    const result: AncestorResult = await connection.query(sql, factParameters);
    const discoveredFactTypes = result.rows.reduce(
        (factTypes, r) => addFactType(factTypes, r.name, r.fact_type_id),
        emptyFactTypeMap()
    );
    const records = result.rows.map((r) => {
        const { fields, predecessors }: { fields: {}, predecessors: PredecessorCollection } = r.data as any;
        const fact: PostgresFactRecord = {
            type: r.name,
            hash: r.hash,
            fields,
            predecessors,
            timestamp: r.date_learned
        };
        const signature: FactSignature = {
            publicKey: r.public_key,
            signature: r.signature
        };
        return {
            fact,
            signature
        }
    });
    // Group the records by fact type and hash.
    const envelopes: FactEnvelope[] = records.reduce((acc: FactEnvelope[], record) => {
        // Because the records are sorted by fact ID, we can just look at the last envelope.
        const last = acc.length > 0 ? acc[acc.length - 1] : undefined;
        if (last && last.fact.type === record.fact.type && last.fact.hash === record.fact.hash) {
            last.signatures.push(record.signature);
        }
        else if (record.signature.signature === null) {
            acc.push({
                fact: record.fact,
                signatures: []
            });
        }
        else {
            acc.push({
                fact: record.fact,
                signatures: [record.signature]
            });
        }
        return acc;
    }, []);
    // Assuming that the facts were inserted in topological order, they don't need to be sorted.
    return { envelopes, discoveredFactTypes };
}

async function executeQueryTree(sqlQueryTree: SqlQueryTree, connection: PoolClient): Promise<ResultSetTree> {
    const sqlQuery = sqlQueryTree.sqlQuery;
    const { rows: dataRows } = await connection.query(sqlQuery.sql, sqlQuery.parameters);
    const rows: ResultSetRow[] = dataRows.map(dataRow => {
        const row = sqlQuery.labels.reduce((acc, label) => {
            const fact: ResultSetFact = {
                hash: dataRow[`hash${label.index}`],
                factId: dataRow[`id${label.index}`],
                data: dataRow[`data${label.index}`],
                timestamp: dataRow[`timestamp${label.index}`],
            };
            return {
                ...acc,
                [label.index]: fact
            };
        }, {} as ResultSetRow);
        return row;
    });
    const resultSets: ResultSetTree = {
        resultSet: rows,
        childResultSets: []
    };
    for (const child of sqlQueryTree.childQueries) {
        const childResultSet = await executeQueryTree(child, connection);
        resultSets.childResultSets.push({
            name: child.name,
            ...childResultSet
        });
    }
    return resultSets;
}

function predecessorTypes(predecessor: FactReference[] | FactReference): string[] {
    if (Array.isArray(predecessor)) {
        return predecessor.map(p => p.type);
    }
    return [predecessor.type];
}

function predecessorCollectionTypes(predecessors: PredecessorCollection): string[] {
    return Object.keys(predecessors).flatMap(key => predecessorTypes(predecessors[key]));
}

async function storeFactTypes(facts: FactRecord[], factTypes: FactTypeMap, connection: PoolClient, schema: string) {
    const newFactTypes = facts
        .flatMap(fact => [fact.type, ...predecessorCollectionTypes(fact.predecessors)])
        .filter(type => !factTypes.has(type))
        .filter(distinct);
    if (newFactTypes.length === 0) {
        return factTypes;
    }

    // Look up existing fact types
    const loadedFactTypes = await loadFactTypes(newFactTypes, connection, schema);
    const remainingNames = newFactTypes.filter(type => !loadedFactTypes.has(type));
    if (remainingNames.length === 0) {
        return mergeFactTypes(loadedFactTypes, factTypes);
    }

    // Insert new fact types
    const values = remainingNames.map((name, index) => `($${index + 1})`);
    const insertSql = `INSERT INTO ${schema}.fact_type (name) VALUES ` + values.join(', ') +
        ' RETURNING fact_type_id, name;';
    const { rows: newRows }: FactTypeResult = await connection.query(insertSql, remainingNames);
    if (newRows.length !== remainingNames.length) {
        throw new Error('Failed to insert all new fact types.');
    }
    const allFactTypes = newRows.reduce(
        (map, row) => addFactType(map, row.name, row.fact_type_id),
        mergeFactTypes(loadedFactTypes, factTypes)
    );
    return allFactTypes;
}

async function loadFactTypes(factTypeNames: string[], connection: PoolClient, schema: string) {
    const lookUpSql = `SELECT name, fact_type_id FROM ${schema}.fact_type WHERE name=ANY($1);`;
    const { rows: existingRows }: FactTypeResult = await connection.query(lookUpSql, [factTypeNames]);
    const factTypeIds = existingRows.reduce(
        (map, row) => addFactType(map, row.name, row.fact_type_id),
        emptyFactTypeMap()
    );
    return factTypeIds;
}

// Resolve fact type names on the given connection, merging into the map
// supplied rather than into any shared cache.
async function resolveFactTypes(typeNames: string[], factTypes: FactTypeMap, connection: PoolClient, schema: string): Promise<FactTypeMap> {
    const unknownFactTypes = typeNames
        .filter(distinct)
        .filter(factType => !factTypes.has(factType));
    if (unknownFactTypes.length === 0) {
        return factTypes;
    }
    const loadedFactTypes = await loadFactTypes(unknownFactTypes, connection, schema);
    return mergeFactTypes(factTypes, loadedFactTypes);
}

// Resolve a specification's roles on the given connection. The role map passed
// in is the caller's own, so loadRoles may add to it in place.
async function resolveRoles(specification: Specification, factTypes: FactTypeMap, roleMap: RoleMap, connection: PoolClient, schema: string): Promise<RoleMap> {
    const unknownRoles = getAllRoles(specification)
        .filter(r => getFactTypeId(factTypes, r.successorType))
        .map(r => ({
            successor_type_id: getFactTypeId(factTypes, r.successorType)!,
            role: r.name
        }))
        .filter(r => r.successor_type_id && !hasRole(roleMap, r.successor_type_id, r.role));
    if (unknownRoles.length === 0) {
        return roleMap;
    }
    return await loadRoles(unknownRoles, roleMap, connection, schema);
}

async function storeRoles(facts: FactRecord[], factTypes: FactTypeMap, roleMap: RoleMap, connection: PoolClient, schema: string) {
    // Find distinct roles
    const roles = flatten(facts, fact => {
        const successor_type_id = ensureGetFactTypeId(factTypes, fact.type);
        return Object.keys(fact.predecessors).map(role => ({
            role,
            successor_type_id
        }));
    }).filter((role, index, array) => array.findIndex(r =>
        r.role === role.role &&
        r.successor_type_id === role.successor_type_id
    ) === index);

    if (roles.length > 0) {
        // Look up existing roles
        const roleIds = await loadRoles(roles, roleMap, connection, schema);
        const remainingRoles = roles.filter(role => !hasRole(
            roleIds, role.successor_type_id, role.role));
        if (remainingRoles.length === 0) {
            return roleIds;
        }

        // Insert new roles
        const remainingRoleValues = remainingRoles.map((role, index) =>
            `($${index * 2 + 1}, $${index * 2 + 2}::integer)`);
        const insertSql = `INSERT INTO ${schema}.role (name, defining_fact_type_id) VALUES ` +
            remainingRoleValues.join(', ') +
            ' RETURNING role_id, name, defining_fact_type_id;';
        const remainingRoleParameters = flatten(remainingRoles, (role) => [
            role.role,
            role.successor_type_id
        ]);
        const { rows: newRows }: RoleResult = await connection.query(insertSql, remainingRoleParameters);
        if (newRows.length !== remainingRoles.length) {
            throw new Error('Failed to insert all new roles.');
        }
        const allRoleIds = newRows.reduce(
            (map, row) => addRole(map, row.defining_fact_type_id, row.name, row.role_id),
            roleIds
        );
        return allRoleIds;
    }
    else {
        return roleMap;
    }
}

async function loadRoles(roles: { role: string; successor_type_id: number; }[], roleMap: RoleMap, connection: PoolClient, schema: string) {
    const roleValues = roles.map((role, index) =>
        `($${index * 2 + 1}, $${index * 2 + 2}::integer)`);
    const roleParameters = flatten(roles, (role) => [
        role.role,
        role.successor_type_id
    ]);

    const lookUpSql = 'SELECT role.name, role.defining_fact_type_id, role.role_id' +
        ` FROM ${schema}.role` +
        ' JOIN (VALUES ' + roleValues.join(', ') + ') AS v (name, defining_fact_type_id)' +
        ' ON v.name = role.name AND v.defining_fact_type_id = role.defining_fact_type_id;';
    const { rows }: RoleResult = await connection.query(lookUpSql, roleParameters);
    const roleIds = rows.reduce(
        (map, row) => addRole(map, row.defining_fact_type_id, row.name, row.role_id),
        roleMap
    );
    return roleIds;
}

async function findExistingFacts(facts: FactRecord[], factTypes: FactTypeMap, connection: PoolClient, schema: string) {
    if (facts.length > 0) {
        const factReferences: FactReference[] = facts.flatMap(fact => [
            ...predecessorsOf(fact),
            fact
        ]);
        const factValues = factReferences.map((f, i) =>
            `(\$${i * 2 + 1}, \$${i * 2 + 2}::integer)`);
        const factParameters = factReferences.flatMap((f) =>
            [f.hash, factTypes.get(f.type)]);

        const sql = 'SELECT fact_id, fact.fact_type_id, fact.hash' +
            ` FROM ${schema}.fact` +
            ' JOIN (VALUES ' + factValues.join(', ') + ') AS v (hash, fact_type_id)' +
            ' ON v.fact_type_id = fact.fact_type_id AND v.hash = fact.hash;';
        const { rows }: FactResult = await connection.query(sql, factParameters);
        const existingFacts = rows.reduce(
            (map, row) => addFact(map, row.hash, row.fact_type_id, row.fact_id),
            emptyFactMap()
        );
        return existingFacts;
    }
    else {
        return emptyFactMap();
    }
}

function factKey(reference: FactReference): string {
    return `${reference.type}:${reference.hash}`;
}

/**
 * Orders a batch so that every fact follows the predecessors it is inserted
 * with.
 *
 * The facts are inserted in the order this returns them, so each one takes a
 * `fact_id` above its predecessors'. That is what lets a feed page's bookmark
 * bound rest on one output fact rather than on all of them, and what the
 * `ck_edge_successor_after_predecessor` constraint enforces from then on. The
 * guarantee across batches comes from the save lock (#203); this is the
 * guarantee within one.
 *
 * A predecessor outside the batch is already in the database, so it already
 * has a lower id, and the sorter is told to treat it as placed rather than
 * wait for a fact that will never arrive. A fact the sorter cannot place
 * despite that is still returned, after the ones it placed, so no batch loses
 * a fact to this ordering.
 */
function sortByPredecessor(facts: FactRecord[]): FactRecord[] {
    if (facts.length < 2) {
        return facts;
    }
    const sorter = new TopologicalSorter<FactRecord | null>();
    const batch = new Set<string>(facts.map(factKey));
    facts.forEach(fact => predecessorsOf(fact)
        .filter(predecessor => !batch.has(factKey(predecessor)))
        .forEach(predecessor => sorter.markAsVisited(predecessor, null)));
    const sorted = sorter.sort(facts, (_, fact) => fact)
        .filter((fact): fact is FactRecord => fact !== null);
    if (sorted.length === facts.length) {
        return sorted;
    }
    const placed = new Set<string>(sorted.map(factKey));
    return sorted.concat(facts.filter(fact => !placed.has(factKey(fact))));
}

async function insertFactsEdgesAndAncestors(facts: FactRecord[], factTypes: FactTypeMap, existingFacts: Map<string, Map<number, number>>, connection: PoolClient, roles: RoleMap, schema: string) {
    if (facts.length === 0) {
        return emptyFactMap();
    }

    const { sql, parameters } = sqlInsertFacts(facts, roles, factTypes, schema);

    const { rows }: FactResult = await connection.query(sql, parameters);
    if (rows.length !== facts.length) {
        throw new Error('Failed to insert all new facts.');
    }
    const allFacts = rows.reduce(
        (map, row) => addFact(map, row.hash, row.fact_type_id, row.fact_id),
        existingFacts
    );
    return allFacts;
}

function sqlInsertFacts(facts: FactRecord[], roles: RoleMap, factTypes: FactTypeMap, schema: string) {
    const factValues = facts.map((f, i) => `(\$${i * 3 + 1}, \$${i * 3 + 2}::integer, \$${i * 3 + 3}::jsonb)`);
    const factParameters = flatten(facts, (f) => [f.hash, ensureGetFactTypeId(factTypes, f.type), {
        fields: f.fields,
        predecessors: canonicalPredecessors(f.predecessors)
    }]);

    const edgeRecords = flatten(facts, fact => makeEdgeRecords(fact));
    if (edgeRecords.length > 0) {
        // The statement below inserts from a SELECT over this list, and a
        // SELECT with no ORDER BY has no order to rely on. Carry each fact's
        // position in the batch so the insert can order by it, and so the ids
        // follow the order `sortByPredecessor` put the facts in. The ordinal is
        // a literal taken from the array index rather than a parameter, so the
        // parameter numbering of the rest of the statement is unchanged.
        const orderedFactValues = facts.map((f, i) =>
            `(\$${i * 3 + 1}, \$${i * 3 + 2}::integer, \$${i * 3 + 3}::jsonb, ${i})`);
        return sqlInsertFactsEdgesAndAncestors(facts, factParameters, edgeRecords, factTypes, roles, orderedFactValues, schema);
    }
    else {
        return {
            sql: `INSERT INTO ${schema}.fact (hash, fact_type_id, data) VALUES ` +
                factValues.join(', ') +
                ' RETURNING fact_id, hash, fact_type_id;',
            parameters: factParameters
        };
    }
}

function sqlInsertFactsEdgesAndAncestors(facts: FactRecord[], factParameters: (string | number | { fields: {}; predecessors: PredecessorCollection; })[], edgeRecords: EdgeRecord[], factTypes: FactTypeMap, roles: RoleMap, factValues: string[], schema: string) {
    let parameterOffset = factParameters.length;
    const edgeValues = edgeRecords.map((e, i) => `(\$${i * 5 + 1 + parameterOffset}, \$${i * 5 + 2 + parameterOffset}::integer, \$${i * 5 + 3 + parameterOffset}, \$${i * 5 + 4 + parameterOffset}::integer, \$${i * 5 + 5 + parameterOffset}::integer)`);
    const edgeParameters = flatten(edgeRecords, (e) => {
        const successor_fact_type_id = ensureGetFactTypeId(factTypes, e.successor_type);
        const predecessor_fact_type_id = ensureGetFactTypeId(factTypes, e.predecessor_type);
        return [
            e.successor_hash,
            successor_fact_type_id,
            e.predecessor_hash,
            predecessor_fact_type_id,
            getRoleId(roles, successor_fact_type_id, e.role)
        ];
    });

    parameterOffset += edgeParameters.length;
    const ancestors = ancestorRecords(facts);
    const ancestorValues = ancestors.map((a, i) => `(\$${i * 4 + 1 + parameterOffset}, \$${i * 4 + 2 + parameterOffset}::integer, \$${i * 4 + 3 + parameterOffset}, \$${i * 4 + 4 + parameterOffset}::integer)`);
    const ancestorParameters = flatten(ancestors, (a) => [
        a.fact.hash,
        factTypes.get(a.fact.type),
        a.ancestor.hash,
        factTypes.get(a.ancestor.type)
    ]);

    const sql =
`WITH new_fact AS (
    SELECT hash, fact_type_id, data, ordinal
    FROM (VALUES ${factValues.join(', ')})
        AS fv (hash, fact_type_id, data, ordinal)
),
new_edge AS (
    SELECT successor_hash, successor_fact_type_id, predecessor_hash, predecessor_fact_type_id, role_id
    FROM (VALUES ${edgeValues.join(', ')})
        AS ev (successor_hash, successor_fact_type_id, predecessor_hash, predecessor_fact_type_id, role_id)
),
new_ancestor AS (
    SELECT hash, fact_type_id, ancestor_hash, ancestor_fact_type_id
    FROM (VALUES ${ancestorValues.join(', ')})
        AS ev (hash, fact_type_id, ancestor_hash, ancestor_fact_type_id)
),
inserted_fact AS (
    INSERT INTO ${schema}.fact (hash, fact_type_id, data)
    SELECT hash, fact_type_id, data
    FROM new_fact
    ORDER BY ordinal
    RETURNING fact_id, fact_type_id, hash
),
inserted_edge AS (
    INSERT INTO ${schema}.edge
        (role_id, successor_fact_id, predecessor_fact_id)
    SELECT
        new_edge.role_id,
        successor.fact_id,
        predecessor.fact_id
    FROM new_edge
    JOIN inserted_fact AS successor
        ON successor.hash = new_edge.successor_hash
        AND successor.fact_type_id = new_edge.successor_fact_type_id
    JOIN (
        SELECT fact_id, fact_type_id, hash
        FROM inserted_fact
        UNION ALL
        SELECT fact_id, fact_type_id, hash
        FROM ${schema}.fact
    ) AS predecessor
        ON predecessor.hash = new_edge.predecessor_hash
        AND predecessor.fact_type_id = new_edge.predecessor_fact_type_id
    ON CONFLICT DO NOTHING
),
ancestor_id AS (
    SELECT
        fact.fact_id,
        ancestor.fact_id AS ancestor_fact_id
    FROM new_ancestor
    JOIN inserted_fact AS fact
        ON fact.hash = new_ancestor.hash
        AND fact.fact_type_id = new_ancestor.fact_type_id
    JOIN (
        SELECT fact_id, fact_type_id, hash
        FROM inserted_fact
        UNION ALL
        SELECT fact_id, fact_type_id, hash
        FROM ${schema}.fact
    ) AS ancestor
        ON ancestor.hash = new_ancestor.ancestor_hash
        AND ancestor.fact_type_id = new_ancestor.ancestor_fact_type_id
),
inserted_ancestor AS (
    INSERT INTO ${schema}.ancestor
        (fact_id, ancestor_fact_id)
        SELECT ancestor_id.fact_id, ancestor_id.ancestor_fact_id
        FROM ancestor_id
    UNION ALL
        SELECT ancestor_id.fact_id, ancestor.ancestor_fact_id
        FROM ancestor_id
        JOIN ${schema}.ancestor
            ON ancestor.fact_id = ancestor_id.ancestor_fact_id
    ON CONFLICT DO NOTHING
)
SELECT fact_id, fact_type_id, hash
FROM inserted_fact;`;
    const parameters = [...factParameters, ...edgeParameters, ...ancestorParameters];
    return { sql, parameters };
}

function ancestorRecords(facts: FactRecord[]): { fact: FactReference, ancestor: FactReference }[] {
    return facts.flatMap(fact => {
        const factReference: FactReference = { hash: fact.hash, type: fact.type };
        const ancestorReferences: FactReference[] = recursivePredecessors(factReference, facts);
        return ancestorReferences.map(ancestor => (
            {
                fact: factReference,
                ancestor
            }
        ));
    });
}

function recursivePredecessors(factReference: FactReference, facts: FactRecord[]): FactReference[] {
    return facts
        .filter(f => f.hash === factReference.hash && f.type === factReference.type)
        .flatMap(fact => {
            const predecessorReferences = Object.keys(fact.predecessors).flatMap(role => {
                const predecessors = fact.predecessors[role];
                if (Array.isArray(predecessors)) {
                    return predecessors;
                }
                else {
                    return [predecessors];
                }
            });
            const ancestorReferences = predecessorReferences.flatMap(predecessor => recursivePredecessors(predecessor, facts));
            return [...predecessorReferences, ...ancestorReferences];
        });
}

async function storePublicKeys(envelopes: FactEnvelope[], connection: PoolClient, schema: string) {
    // Look up existing fact types
    const publicKeys = flatten(envelopes, e => e.signatures.map(s => s.publicKey))
        .filter(distinct);
    const lookUpSql = `SELECT public_key, public_key_id FROM ${schema}.public_key WHERE public_key=ANY($1);`;
    const { rows: existingRows }: PublicKeyResult = await connection.query(lookUpSql, [publicKeys]);
    const publicKeyIds = existingRows.reduce(
        (map, row) => addFactType(map, row.public_key, row.public_key_id),
        emptyPublicKeyMap()
    );
    const remainingPublicKeys = publicKeys.filter(pk => !publicKeyIds.has(pk));
    if (remainingPublicKeys.length === 0) {
        return publicKeyIds;
    }

    // Insert new fact types
    const values = remainingPublicKeys.map((name, index) => `($${index + 1})`);
    const insertSql = `INSERT INTO ${schema}.public_key (public_key) VALUES ` + values.join(', ') +
        ' RETURNING public_key, public_key_id;';
    const { rows: newRows }: PublicKeyResult = await connection.query(insertSql, remainingPublicKeys);
    if (newRows.length !== remainingPublicKeys.length) {
        throw new Error('Failed to insert all new public keys.');
    }
    const allPublicKeyIds = newRows.reduce(
        (map, row) => addFactType(map, row.public_key, row.public_key_id),
        publicKeyIds
    );
    return allPublicKeyIds;
}

async function insertSignatures(envelopes: FactEnvelope[], allFacts: FactMap, factTypes: FactTypeMap, publicKey: PublicKeyMap, connection: PoolClient, schema: string) {
    const signatureRecords = flatten(envelopes, envelope => envelope.signatures.map(signature => ({
        factId: getFactId(allFacts, envelope.fact.hash, ensureGetFactTypeId(factTypes, envelope.fact.type)),
        publicKeyId: getPublicKeyId(publicKey, signature.publicKey),
        signature: signature.signature
    })));
    if (signatureRecords.length > 0) {
        const signatureValues = signatureRecords.map((s, i) =>
            `($${i * 3 + 1}::integer, $${i * 3 + 2}::integer, $${i * 3 + 3})`);
        const signatureParameters = flatten(signatureRecords, s =>
            [s.factId, s.publicKeyId, s.signature]);

        const sql = `INSERT INTO ${schema}.signature
            (fact_id, public_key_id, signature) 
            (SELECT fact_id, public_key_id, signature 
             FROM (VALUES ${signatureValues.join(', ')}) AS v(fact_id, public_key_id, signature)) 
            ON CONFLICT DO NOTHING`;
        await connection.query(sql, signatureParameters);
    }
}

function predecessorsOf(fact: FactRecord): FactReference[] {
    const references = Object.values(fact.predecessors).flatMap(predecessor =>
        Array.isArray(predecessor) ? predecessor : [predecessor]
    );
    return references;
}