import { FactReference, Specification } from "jinaga";
import { FactTypeMap, RoleMap } from "./maps";
import { EdgeDescription, FactByLabel, QueryDescription, QueryDescriptionBuilder } from "./query-description";

export function purgeSqlFromSpecification(specification: Specification, factTypes: FactTypeMap, roleMap: RoleMap, schema: string):
    { sql: string, parameters: (string | number)[] } | null {
    const queryDescriptionBuilder = new QueryDescriptionBuilder(factTypes, roleMap);

    let queryDescription = QueryDescription.unsatisfiable;
    let knownFacts: FactByLabel = {};
    const given = specification.given;
    const start: FactReference[] = specification.given.map(g => ({ type: g.type, hash: 'xxxxx' }));
    ({ queryDescription, knownFacts } = queryDescriptionBuilder.addEdges(queryDescription, given, start, knownFacts, [], specification.matches));

    if (!queryDescription.isSatisfiable()) {
        return null;
    }

    const query = generatePurgeSqlQuery(queryDescription, schema);
    return query;
}


function generatePurgeSqlQuery(queryDescription: QueryDescription, schema: string):
    { sql: string, parameters: (string | number)[] } {
    if (queryDescription.existentialConditions.length > 0) {
        throw new Error("Purge conditions should not have existential conditions");
    }

    const columns = queryDescription.outputs
        .map((label, index) => `f${label.factIndex}.fact_id as trigger${index + 1}`)
        .join(",\n        ");
    const firstEdge = queryDescription.edges[0];
    const predecessorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.predecessorFactIndex);
    const successorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.successorFactIndex);
    const firstFactIndex = predecessorFact ? predecessorFact.factIndex : successorFact!.factIndex;
    const writtenFactIndexes = new Set<number>().add(firstFactIndex);
    const joins: string[] = generateJoins(queryDescription.edges, writtenFactIndexes, schema);
    const inputWhereClauses = queryDescription.inputs
        .map(input => `f${input.factIndex}.fact_type_id = $${input.factTypeParameter}`)
        .join(" AND ");
    const triggerWhereClauses = queryDescription.outputs
        .map((label, index) => `a.fact_id = c2.trigger${index + 1}`)
        .join("\n            OR ");

    const sql =
        `WITH candidates AS (\n` +
        `    SELECT\n` +
        `        f${firstFactIndex}.fact_id as purge_root,\n` +
        `        ${columns}\n` +
        `    FROM ${schema}.fact f${firstFactIndex}\n${joins.join("")}` +
        `    WHERE ${inputWhereClauses}\n` +
        `), targets AS (\n` +
        `    SELECT a.fact_id\n` +
        `    FROM public.ancestor a\n` +
        `    JOIN candidates c ON c.purge_root = a.ancestor_fact_id\n` +
        `    WHERE NOT EXISTS (\n` +
        `        SELECT 1\n` +
        `        FROM candidates c2\n` +
        `        WHERE ${triggerWhereClauses}\n` +
        `    )\n` +
        `), facts AS (\n` +
        `    DELETE\n` +
        `    FROM public.fact f\n` +
        `    USING targets t WHERE t.fact_id = f.fact_id\n` +
        `    RETURNING f.fact_id\n` +
        `)\n` +
        `SELECT fact_id FROM facts\n`;
    
    // Remove parameter 1, which is the hash of the first fact
    const parameters = [
        queryDescription.parameters[0],
        ...queryDescription.parameters.slice(2)
    ];
        

    return {
        sql,
        parameters: parameters
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
                    `        AND e${edge.edgeIndex}.role_id = $${edge.roleParameter - 1}\n`
                );
            }
            else {
                joins.push(
                    `    JOIN ${schema}.edge e${edge.edgeIndex}\n` +
                    `        ON e${edge.edgeIndex}.predecessor_fact_id = f${edge.predecessorFactIndex}.fact_id\n` +
                    `        AND e${edge.edgeIndex}.role_id = $${edge.roleParameter - 1}\n`
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
                `        AND e${edge.edgeIndex}.role_id = $${edge.roleParameter - 1}\n`
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