import {
    canonicalPredecessors,
    FactEnvelope,
    FactFeed,
    FactRecord,
    FactReference,
    factReferenceEquals,
    FactTuple,
    getAllFactTypes,
    getAllRoles,
    PredecessorCollection,
    ProjectedResult,
    Specification,
    Storage,
    TopologicalSorter
} from "jinaga";
import { Pool, PoolClient } from "pg";

import { distinct, flatten } from "../util/fn";
import { ConnectionFactory, Row } from "./connection";
import { EdgeRecord, makeEdgeRecords } from "./edge-record";
import {
    addFact,
    addFactType,
    addRole,
    copyRoleMap,
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

export class PostgresStore implements Storage {
    private connectionFactory: ConnectionFactory;
    private factTypeMap: FactTypeMap = emptyFactTypeMap();
    private roleMap: RoleMap = emptyRoleMap();

    constructor (pool: Pool, private schema: string) {
        this.connectionFactory = new ConnectionFactory(pool);
    }

    close() {
        return Promise.resolve();
    }
    
    async save(envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        if (envelopes.length > 0) {
            const facts = envelopes.map(e => e.fact);
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
                const newFacts = facts.filter(f => !hasFact(existingFacts, f.hash, ensureGetFactTypeId(factTypes, f.type)));
                if (newFacts.length === 0) {
                    return {
                        newEnvelopes: [],
                        factTypes,
                        roles: emptyRoleMap()
                    };
                }

                const roles = await storeRoles(newFacts, factTypes, copyRoleMap(this.roleMap), connection, this.schema);
                const allFacts = await insertFactsEdgesAndAncestors(newFacts, factTypes, existingFacts, connection, roles, this.schema);
                const newEnvelopes = envelopes.filter(envelope => newFacts.some(
                    factReferenceEquals(envelope.fact)));
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

    async read(start: FactReference[], specification: Specification): Promise<ProjectedResult[]> {
        const factTypes = await this.loadFactTypesFromSpecification(specification);
        const roleMap = await this.loadRolesFromSpecification(specification, factTypes);

        // If any of the start facts are not known types, the specification cannot be satisfied.
        if (start.filter(f => getFactTypeId(factTypes, f.type) === undefined).length > 0) {
            return [];
        }

        const composer = resultSqlFromSpecification(start, specification, factTypes, roleMap, this.schema);
        if (composer === null) {
            return [];
        }
        
        const sqlQueryTree = composer.getSqlQueries();
        const resultSets = await this.connectionFactory.with(async (connection) => {
            return await executeQueryTree(sqlQueryTree, connection);
        });

        // Find the references for fact projections
        const factReferences: FactReference[] = composer.findFactReferences(resultSets);

        // Load the references into a fact tree
        const factRecords = await this.load(factReferences);

        return composer.compose(resultSets, factRecords);
    }

    async feed(feed: Specification, start: FactReference[], bookmark: string): Promise<FactFeed> {
        const factTypes: FactTypeMap = await this.loadFactTypesFromFeed(feed);
        const roleMap: RoleMap = await this.loadRolesFromFeed(feed, factTypes);
        const sql = sqlFromFeed(feed, start, this.schema, bookmark, 100, factTypes, roleMap);
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

    async load(references: FactReference[]): Promise<FactRecord[]> {
        if (references.length === 0) {
            return [];
        }

        const factTypes = await this.loadFactTypesFromReferences(references);

        const factValues = references.map((f, i) =>
            `(\$${i * 2 + 1}, \$${i * 2 + 2}::integer)`);
        const factParameters = flatten(references, (f) =>
            [f.hash, factTypes.get(f.type)]);
        const sql =
            'SELECT f.fact_type_id, t.name, f.hash, f.data ' +
            `FROM ${this.schema}.fact f ` +
            `JOIN ${this.schema}.fact_type t ` +
            '  ON f.fact_type_id = t.fact_type_id ' +
            'JOIN (VALUES ' + factValues.join(', ') + ') AS v (hash, fact_type_id) ' +
            '  ON v.fact_type_id = f.fact_type_id AND v.hash = f.hash ' +
            'UNION ' +
            'SELECT f2.fact_type_id, t.name, f2.hash, f2.data ' +
            `FROM ${this.schema}.fact f1 ` +
            'JOIN (VALUES ' + factValues.join(', ') + ') AS v (hash, fact_type_id) ' +
            '  ON v.fact_type_id = f1.fact_type_id AND v.hash = f1.hash ' +
            `JOIN ${this.schema}.ancestor a ` +
            '  ON a.fact_id = f1.fact_id ' +
            `JOIN ${this.schema}.fact f2 ` +
            '  ON f2.fact_id = a.ancestor_fact_id ' +
            `JOIN ${this.schema}.fact_type t ` +
            '  ON t.fact_type_id = f2.fact_type_id;';
        const result: AncestorResult = await this.connectionFactory.with(async (connection) => {
            return await connection.query(sql, factParameters);
        })
        const resultFactTypes = result.rows.reduce(
            (factTypes, r) => addFactType(factTypes, r.name, r.fact_type_id),
            emptyFactTypeMap()
        );
        this.factTypeMap = mergeFactTypes(this.factTypeMap, resultFactTypes);
        const sorter = new TopologicalSorter<FactRecord>();
        const records = result.rows.map((r) => {
            const { fields, predecessors }: { fields: {}, predecessors: PredecessorCollection } = r.data as any;
            return <FactRecord>{
                type: r.name,
                hash: r.hash,
                fields,
                predecessors
            }
        });
        return sorter.sort(records, (p, r) => r);
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

    loadBookmark(feed: string): Promise<string> {
        throw new Error("Method not implemented.");
    }

    saveBookmark(feed: string, bookmark: string): Promise<void> {
        throw new Error("Method not implemented.");
    }

    getMruDate(specificationHash: string): Promise<Date | null> {
        return Promise.resolve(null);
    }
    
    setMruDate(specificationHash: string, mruDate: Date): Promise<void> {
        return Promise.resolve();
    }
}

async function executeQueryTree(sqlQueryTree: SqlQueryTree, connection: PoolClient): Promise<ResultSetTree> {
    const sqlQuery = sqlQueryTree.sqlQuery;
    const { rows: dataRows } = await connection.query(sqlQuery.sql, sqlQuery.parameters);
    const rows: ResultSetRow[] = dataRows.map(dataRow => {
        const row = sqlQuery.labels.reduce((acc, label) => {
            const fact: ResultSetFact = {
                hash: dataRow[`hash${label.index}`],
                factId: dataRow[`id${label.index}`],
                data: dataRow[`data${label.index}`]
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
        return sqlInsertFactsEdgesAndAncestors(facts, factParameters, edgeRecords, factTypes, roles, factValues, schema);
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
    SELECT hash, fact_type_id, data
    FROM (VALUES ${factValues.join(', ')})
        AS fv (hash, fact_type_id, data)
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