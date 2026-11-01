import { FactReference, Specification } from "jinaga";
import { FactTypeMap, RoleMap } from "./maps";
import { EdgeDescription, FactByLabel, QueryDescription, QueryDescriptionBuilder } from "./query-description";

export function purgeDescendantsSql(triggerCount: number, schema: string): string {
    let whereClause = "    WHERE (t.fact_type_id = $3 AND t.hash = $4)\n";
    for (let i = 1; i < triggerCount; i++) {
        whereClause += `        OR (t.fact_type_id = $${i * 2 + 3} AND t.hash = $${i * 2 + 4})\n`;
    }
    const sql =
        `WITH purge_root AS (\n` +
        `    SELECT pr.fact_id\n` +
        `    FROM ${schema}.fact pr\n` +
        `    WHERE pr.fact_type_id = $1\n` +
        `        AND pr.hash = $2\n` +
        `), triggers AS (\n` +
        `    SELECT t.fact_id\n` +
        `    FROM ${schema}.fact t\n` +
        whereClause +
        `), triggers_and_ancestors AS (\n` +
        `    SELECT t.fact_id\n` +
        `    FROM triggers t\n` +
        `    UNION\n` +
        `    SELECT a.ancestor_fact_id\n` +
        `    FROM ${schema}.ancestor a\n` +
        `    JOIN triggers t\n` +
        `        ON a.fact_id = t.fact_id\n` +
        `), targets AS (\n` +
        `    SELECT a.fact_id\n` +
        `    FROM ${schema}.ancestor a\n` +
        `    JOIN purge_root pr\n` +
        `        ON a.ancestor_fact_id = pr.fact_id\n` +
        `    WHERE a.fact_id NOT IN (SELECT * FROM triggers_and_ancestors)\n` +
        `), facts AS (\n` +
        `    DELETE\n` +
        `    FROM ${schema}.fact f\n` +
        `    USING targets t WHERE t.fact_id = f.fact_id\n` +
        `    RETURNING f.fact_id\n` +
        `)\n` +
        `SELECT fact_id FROM facts\n`;
    return sql;
}

export function purgeSqlFromSpecification(specification: Specification, factTypes: FactTypeMap, roleMap: RoleMap, schema: string):
    { sql: string, parameters: (string | number)[] } | null {
    return purgeSqlFromSpecifications([specification], factTypes, roleMap, schema);
}

/**
 * Generate one statement that purges under every given purge condition at once.
 * The conditions must share a given type. Every trigger of every condition,
 * and every ancestor of those triggers, is spared. Running the conditions one
 * statement at a time would let one condition delete another's triggers.
 */
export function purgeSqlFromSpecifications(specifications: Specification[], factTypes: FactTypeMap, roleMap: RoleMap, schema: string):
    { sql: string, parameters: (string | number)[] } | null {
    const queryDescriptions = specifications
        .map(specification => purgeQueryDescription(specification, factTypes, roleMap))
        .filter((queryDescription): queryDescription is QueryDescription => queryDescription !== null);

    if (queryDescriptions.length === 0) {
        return null;
    }

    return generatePurgeSqlQuery(queryDescriptions, schema);
}

function purgeQueryDescription(specification: Specification, factTypes: FactTypeMap, roleMap: RoleMap): QueryDescription | null {
    const queryDescriptionBuilder = new QueryDescriptionBuilder(factTypes, roleMap);

    let queryDescription = QueryDescription.unsatisfiable;
    let knownFacts: FactByLabel = {};
    const given = specification.given.map(g => g.label);
    const start: FactReference[] = specification.given.map(g => ({ type: g.label.type, hash: 'xxxxx' }));
    
    // Process main matches
    ({ queryDescription, knownFacts } = queryDescriptionBuilder.addEdges(queryDescription, given, start, knownFacts, [], specification.matches));
    
    // Process conditions from given
    for (const givenItem of specification.given) {
        if (givenItem.conditions && givenItem.conditions.length > 0) {
            for (const condition of givenItem.conditions) {
                const { query: queryDescriptionWithExistential, path: conditionalPath } = queryDescription.withExistentialCondition(condition.exists, []);
                const { queryDescription: queryDescriptionConditional } = queryDescriptionBuilder.addEdges(queryDescriptionWithExistential, given, start, knownFacts, conditionalPath, condition.matches);
                
                if (queryDescriptionConditional.isSatisfiable()) {
                    queryDescription = queryDescriptionConditional;
                }
            }
        }
    }

    if (!queryDescription.isSatisfiable()) {
        return null;
    }

    if (queryDescription.existentialConditions.length > 0) {
        throw new Error("Purge conditions should not have existential conditions");
    }

    return queryDescription;
}

function generatePurgeSqlQuery(queryDescriptions: QueryDescription[], schema: string):
    { sql: string, parameters: (string | number)[] } {
    const parameters: (string | number)[] = [];
    const candidateCtes: string[] = [];
    const rootSelects: string[] = [];
    const triggerSelects: string[] = [];

    queryDescriptions.forEach((queryDescription, conditionIndex) => {
        const name = `candidates${conditionIndex + 1}`;
        const offset = parameters.length;
        candidateCtes.push(`${name} AS (\n${generateCandidates(queryDescription, offset, schema)})`);
        // Remove parameter 2, which is the hash of the first fact
        parameters.push(
            queryDescription.parameters[0],
            ...queryDescription.parameters.slice(2)
        );
        rootSelects.push(`    SELECT purge_root FROM ${name}\n`);
        queryDescription.outputs.forEach((label, index) => {
            triggerSelects.push(`    SELECT trigger${index + 1} AS fact_id FROM ${name}\n`);
        });
    });

    const sql =
        `WITH ${candidateCtes.join(", ")}, roots AS (\n` +
        rootSelects.join(`    UNION\n`) +
        `), triggers AS (\n` +
        triggerSelects.join(`    UNION\n`) +
        `), targets AS (\n` +
        `    SELECT a.fact_id\n` +
        `    FROM ${schema}.ancestor a\n` +
        `    JOIN roots r ON r.purge_root = a.ancestor_fact_id\n` +
        `    WHERE NOT EXISTS (\n` +
        `        SELECT 1\n` +
        `        FROM triggers t\n` +
        `        WHERE a.fact_id = t.fact_id\n` +
        `    )\n` +
        `    AND NOT EXISTS (\n` +
        `        SELECT 1\n` +
        `        FROM triggers t\n` +
        `        JOIN ${schema}.ancestor a2\n` +
        `            ON a2.fact_id = t.fact_id\n` +
        `        WHERE a.fact_id = a2.ancestor_fact_id\n` +
        `    )\n` +
        `), facts AS (\n` +
        `    DELETE\n` +
        `    FROM ${schema}.fact f\n` +
        `    USING targets t WHERE t.fact_id = f.fact_id\n` +
        `    RETURNING f.fact_id\n` +
        `)\n` +
        `SELECT fact_id FROM facts\n`;

    return {
        sql,
        parameters
    };
}

function generateCandidates(queryDescription: QueryDescription, offset: number, schema: string): string {
    const columns = queryDescription.outputs
        .map((label, index) => `f${label.factIndex}.fact_id as trigger${index + 1}`)
        .join(",\n        ");
    const firstEdge = queryDescription.edges[0];
    const predecessorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.predecessorFactIndex);
    const successorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.successorFactIndex);
    const firstFactIndex = predecessorFact ? predecessorFact.factIndex : successorFact!.factIndex;
    const writtenFactIndexes = new Set<number>().add(firstFactIndex);
    const joins: string[] = generateJoins(queryDescription.edges, writtenFactIndexes, offset, schema);
    const inputWhereClauses = queryDescription.inputs
        .map(input => `f${input.factIndex}.fact_type_id = $${input.factTypeParameter + offset}`)
        .join(" AND ");

    return (
        `    SELECT\n` +
        `        f${firstFactIndex}.fact_id as purge_root,\n` +
        `        ${columns}\n` +
        `    FROM ${schema}.fact f${firstFactIndex}\n${joins.join("")}` +
        `    WHERE ${inputWhereClauses}\n`
    );
}

function generateJoins(edges: EdgeDescription[], writtenFactIndexes: Set<number>, offset: number, schema: string) {
    const joins: string[] = [];
    edges.forEach(edge => {
        if (writtenFactIndexes.has(edge.predecessorFactIndex)) {
            if (writtenFactIndexes.has(edge.successorFactIndex)) {
                joins.push(
                    `    JOIN ${schema}.edge e${edge.edgeIndex}\n` +
                    `        ON e${edge.edgeIndex}.predecessor_fact_id = f${edge.predecessorFactIndex}.fact_id\n` +
                    `        AND e${edge.edgeIndex}.successor_fact_id = f${edge.successorFactIndex}.fact_id\n` +
                    `        AND e${edge.edgeIndex}.role_id = $${edge.roleParameter - 1 + offset}\n`
                );
            }
            else {
                joins.push(
                    `    JOIN ${schema}.edge e${edge.edgeIndex}\n` +
                    `        ON e${edge.edgeIndex}.predecessor_fact_id = f${edge.predecessorFactIndex}.fact_id\n` +
                    `        AND e${edge.edgeIndex}.role_id = $${edge.roleParameter - 1 + offset}\n`
                );
                joins.push(
                    `    JOIN ${schema}.fact f${edge.successorFactIndex}\n` +
                    `        ON f${edge.successorFactIndex}.fact_id = e${edge.edgeIndex}.successor_fact_id\n`
                );
                writtenFactIndexes.add(edge.successorFactIndex);
            }
        }
        else if (writtenFactIndexes.has(edge.successorFactIndex)) {
            joins.push(
                `    JOIN ${schema}.edge e${edge.edgeIndex}\n` +
                `        ON e${edge.edgeIndex}.successor_fact_id = f${edge.successorFactIndex}.fact_id\n` +
                `        AND e${edge.edgeIndex}.role_id = $${edge.roleParameter - 1 + offset}\n`
            );
            joins.push(
                `    JOIN ${schema}.fact f${edge.predecessorFactIndex}\n` +
                `        ON f${edge.predecessorFactIndex}.fact_id = e${edge.edgeIndex}.predecessor_fact_id\n`
            );
            writtenFactIndexes.add(edge.predecessorFactIndex);
        }
        else {
            throw new Error("Neither predecessor nor successor fact has been written");
        }
    });
    return joins;
}