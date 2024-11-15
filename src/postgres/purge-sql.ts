import { FactReference, Specification } from "jinaga";
import { FactTypeMap, RoleMap } from "./maps";
import { EdgeDescription, ExistentialConditionDescription, FactByLabel, QueryDescription, QueryDescriptionBuilder } from "./query-description";

export function purgeSqlFromSpecification(specification: Specification, factTypes: FactTypeMap, roleMap: RoleMap, schema: string):
    { sql: string, parameters: (string | number)[] } {
    const queryDescriptionBuilder = new QueryDescriptionBuilder(factTypes, roleMap);

    let queryDescription = QueryDescription.unsatisfiable;
    let knownFacts: FactByLabel = {};
    const given = specification.given;
    const start: FactReference[] = specification.given.map(g => ({ type: g.type, hash: 'xxxxx' }));
    ({ queryDescription, knownFacts } = queryDescriptionBuilder.addEdges(queryDescription, given, start, knownFacts, [], specification.matches));

    const query = generatePurgeSqlQuery(queryDescription, schema);
    return query;
}


function generatePurgeSqlQuery(queryDescription: QueryDescription, schema: string):
    { sql: string, parameters: (string | number)[] } {
    const columns = queryDescription.outputs
        .map(label => `f${label.factIndex}.fact_id as trigger${label.factIndex - 1}`)
        .join(",\n");
    const firstEdge = queryDescription.edges[0];
    const predecessorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.predecessorFactIndex);
    const successorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.successorFactIndex);
    const firstFactIndex = predecessorFact ? predecessorFact.factIndex : successorFact!.factIndex;
    const writtenFactIndexes = new Set<number>().add(firstFactIndex);
    const joins: string[] = generateJoins(queryDescription.edges, writtenFactIndexes, schema);
    const inputWhereClauses = queryDescription.inputs
        .map(input => `f${input.factIndex}.fact_type_id = $${input.factTypeParameter}`)
        .join(" AND ");
    const existentialWhereClauses = queryDescription.existentialConditions
        .map(existentialCondition => ` AND ${existentialCondition.exists ? "EXISTS" : "NOT EXISTS"} (${generateExistentialWhereClause(existentialCondition, writtenFactIndexes, schema)})`)
        .join("");
    const sql =
        `WITH candidates AS (\n` +
        `    SELECT\n` +
        `        f${firstFactIndex}.fact_id as purge_root,\n` +
        `        ${columns}\n` +
        `    FROM ${schema}.fact f${firstFactIndex}\n${joins.join("")}` +
        `    WHERE ${inputWhereClauses}\n` +
        `    ${existentialWhereClauses}`;

    return {
        sql,
        parameters: queryDescription.parameters
    };
}

function generateJoins(edges: EdgeDescription[], writtenFactIndexes: Set<number>, schema: string) {
    const joins: string[] = [];
    edges.forEach(edge => {
        if (writtenFactIndexes.has(edge.predecessorFactIndex)) {
            if (writtenFactIndexes.has(edge.successorFactIndex)) {
                joins.push(
                    `    JOIN ${schema}.edge e${edge.edgeIndex}\n` +
                    `        ON e${edge.edgeIndex}.predecessor_fact_id = f${edge.predecessorFactIndex}.fact_id\n` +
                    `        AND e${edge.edgeIndex}.successor_fact_id = f${edge.successorFactIndex}.fact_id\n` +
                    `        AND e${edge.edgeIndex}.role_id = $${edge.roleParameter}\n`
                );
            }
            else {
                joins.push(
                    `    JOIN ${schema}.edge e${edge.edgeIndex}\n` +
                    `        ON e${edge.edgeIndex}.predecessor_fact_id = f${edge.predecessorFactIndex}.fact_id\n` +
                    `        AND e${edge.edgeIndex}.role_id = $${edge.roleParameter}\n`
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
                `        AND e${edge.edgeIndex}.role_id = $${edge.roleParameter}\n`
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

function generateExistentialWhereClause(existentialCondition: ExistentialConditionDescription, outerFactIndexes: Set<number>, schema: string): string {
    const firstEdge = existentialCondition.edges[0];
    const writtenFactIndexes = new Set<number>(outerFactIndexes);
    const firstJoin: string[] = [];
    const whereClause: string[] = [];
    if (writtenFactIndexes.has(firstEdge.predecessorFactIndex)) {
        if (writtenFactIndexes.has(firstEdge.successorFactIndex)) {
            throw new Error("Not yet implemented");
        }
        else {
            whereClause.push(
                `e${firstEdge.edgeIndex}.predecessor_fact_id = f${firstEdge.predecessorFactIndex}.fact_id` +
                ` AND e${firstEdge.edgeIndex}.role_id = $${firstEdge.roleParameter}`
            );
            firstJoin.push(
                ` JOIN ${schema}.fact f${firstEdge.successorFactIndex}` +
                ` ON f${firstEdge.successorFactIndex}.fact_id = e${firstEdge.edgeIndex}.successor_fact_id`
            );
            writtenFactIndexes.add(firstEdge.successorFactIndex);
        }
    }
    else if (writtenFactIndexes.has(firstEdge.successorFactIndex)) {
        whereClause.push(
            `e${firstEdge.edgeIndex}.successor_fact_id = f${firstEdge.successorFactIndex}.fact_id` +
            ` AND e${firstEdge.edgeIndex}.role_id = $${firstEdge.roleParameter}`
        );
        firstJoin.push(
            ` JOIN ${schema}.fact f${firstEdge.predecessorFactIndex}` +
            ` ON f${firstEdge.predecessorFactIndex}.fact_id = e${firstEdge.edgeIndex}.predecessor_fact_id`
        );
        writtenFactIndexes.add(firstEdge.predecessorFactIndex);
    }
    else {
        throw new Error("Neither predecessor nor successor fact has been written");
    }
    const tailJoins: string[] = generateJoins(existentialCondition.edges.slice(1), writtenFactIndexes, schema);
    const joins = firstJoin.concat(tailJoins);
    const inputWhereClauses = existentialCondition.inputs
        .map(input => ` AND f${input.factIndex}.fact_type_id = $${input.factTypeParameter} AND f${input.factIndex}.hash = $${input.factHashParameter}`)
        .join("");
    const existentialWhereClauses = existentialCondition.existentialConditions
        .map(e => ` AND ${e.exists ? "EXISTS" : "NOT EXISTS"} (${generateExistentialWhereClause(e, writtenFactIndexes, schema)})`)
        .join("");
    return `SELECT 1 FROM ${schema}.edge e${firstEdge.edgeIndex}${joins.join("")} WHERE ${whereClause.join(" AND ")}${inputWhereClauses}${existentialWhereClauses}`;
}
