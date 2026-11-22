import {
    buildFeeds,
    FactReference,
    Specification,
    validateGiven
} from "jinaga";

import { parseBookmarkPositions } from "../util/bookmark";
import { EdgeDescription, ExistentialConditionDescription, FactEqualityDescription, QueryDescription, QueryDescriptionBuilder } from "./query-description";

interface SpecificationLabel {
    type: string;
    index: number;
}

interface SpecificationSqlQuery {
    sql: string;
    parameters: (string | number | number[])[];
    labels: SpecificationLabel[];
    bookmark: string;
};

// An identity condition between two labels that are both already bound
// compares the two facts in the scope where the condition appears. Both fact
// indexes are written by the joins of that scope, or of one enclosing it,
// before the WHERE clause is evaluated.
function factEqualityClauses(factEqualities: FactEqualityDescription[]): string {
    return factEqualities
        .map(equality => ` AND f${equality.leftFactIndex}.fact_id = f${equality.rightFactIndex}.fact_id`)
        .join("");
}

function generateSqlQuery(queryDescription: QueryDescription, schema: string, bookmark: string, limit: number): SpecificationSqlQuery {
    const hashes = queryDescription.outputs
        .map(output => `f${output.factIndex}.hash as hash${output.factIndex}`)
        .join(", ");
    const factIds = queryDescription.outputs
        .map(output => `f${output.factIndex}.fact_id`)
        .join(", ");
    const firstEdge = queryDescription.edges[0];
    const predecessorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.predecessorFactIndex);
    const successorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.successorFactIndex);
    const firstFactIndex = predecessorFact ? predecessorFact.factIndex : successorFact!.factIndex;
    const writtenFactIndexes = new Set<number>().add(firstFactIndex);
    const givenFactIndexes = new Set<number>(queryDescription.inputs.map(input => input.factIndex));
    const joins: string[] = generateJoins(schema, queryDescription.edges, writtenFactIndexes, givenFactIndexes);
    const inputWhereClauses = queryDescription.inputs
        .filter(input => input.factTypeParameter !== 0)
        .map(input => `f${input.factIndex}.fact_type_id = $${input.factTypeParameter} AND f${input.factIndex}.hash = $${input.factHashParameter}`)
        .join(" AND ");
    const notExistsWhereClauses = (queryDescription.existentialConditions
        .filter(c => c.exists === false))
        .map(notExistsWhereClause => ` AND NOT EXISTS (${generateNotExistsWhereClause(schema, notExistsWhereClause, writtenFactIndexes)})`)
        .join("");
    const existsWhereClauses = (queryDescription.existentialConditions
        .filter(c => c.exists === true))
        .map(existsWhereClause => ` AND EXISTS (${generateNotExistsWhereClause(schema, existsWhereClause, writtenFactIndexes)})`)
        .join("");
    const factEqualityWhereClauses = factEqualityClauses(queryDescription.factEqualities);
    const bookmarkParameter = queryDescription.parameters.length + 1;
    const limitParameter = bookmarkParameter + 1;
    const sql = `SELECT ${hashes}, sort(array[${factIds}], 'desc') as bookmark FROM ${schema}.fact f${firstFactIndex}${joins.join("")} WHERE ${inputWhereClauses}${factEqualityWhereClauses}${notExistsWhereClauses}${existsWhereClauses} AND sort(array[${factIds}], 'desc') > $${bookmarkParameter} ORDER BY bookmark ASC LIMIT $${limitParameter}`;
    const bookmarkValue: number[] = parseBookmark(bookmark);
    return {
        sql,
        parameters: [...queryDescription.parameters, bookmarkValue, limit],
        labels: queryDescription.outputs.map(output => ({
            type: output.type,
            index: output.factIndex
        })),
        bookmark: "[]"
    };
}

// An edge reaches a fact from one that the joins have already written. When
// neither end has been written, the edge walks from a given that no earlier
// edge reached. Each given is pinned by type and hash in the WHERE clause, so
// bringing it into the FROM clause with a CROSS JOIN costs nothing, and the
// edge then joins as any other does. Mark it written by fact index, so a fact
// index that two unified givens share is brought in at most once. A given is
// brought in only where an edge needs it, which leaves the SQL of every
// specification that already built unchanged.
function crossJoinUnreachedGiven(schema: string, edge: EdgeDescription, writtenFactIndexes: Set<number>, givenFactIndexes: Set<number>, joins: string[]) {
    if (writtenFactIndexes.has(edge.predecessorFactIndex) ||
        writtenFactIndexes.has(edge.successorFactIndex)) {
        return;
    }
    const unreachedGiven = [edge.predecessorFactIndex, edge.successorFactIndex]
        .find(factIndex => givenFactIndexes.has(factIndex));
    if (unreachedGiven === undefined) {
        return;
    }
    joins.push(` CROSS JOIN ${schema}.fact f${unreachedGiven}`);
    writtenFactIndexes.add(unreachedGiven);
}

function generateJoins(schema: string, edges: EdgeDescription[], writtenFactIndexes: Set<number>, givenFactIndexes: Set<number>) {
    const joins: string[] = [];
    edges.forEach(edge => {
        crossJoinUnreachedGiven(schema, edge, writtenFactIndexes, givenFactIndexes, joins);
        if (writtenFactIndexes.has(edge.predecessorFactIndex)) {
            if (writtenFactIndexes.has(edge.successorFactIndex)) {
                joins.push(
                    ` JOIN ${schema}.edge e${edge.edgeIndex}` +
                    ` ON e${edge.edgeIndex}.predecessor_fact_id = f${edge.predecessorFactIndex}.fact_id` +
                    ` AND e${edge.edgeIndex}.successor_fact_id = f${edge.successorFactIndex}.fact_id` +
                    ` AND e${edge.edgeIndex}.role_id = $${edge.roleParameter}`
                );
            }
            else {
                joins.push(
                    ` JOIN ${schema}.edge e${edge.edgeIndex}` +
                    ` ON e${edge.edgeIndex}.predecessor_fact_id = f${edge.predecessorFactIndex}.fact_id` +
                    ` AND e${edge.edgeIndex}.role_id = $${edge.roleParameter}`
                );
                joins.push(
                    ` JOIN ${schema}.fact f${edge.successorFactIndex}` +
                    ` ON f${edge.successorFactIndex}.fact_id = e${edge.edgeIndex}.successor_fact_id`
                );
                writtenFactIndexes.add(edge.successorFactIndex);
            }
        }
        else if (writtenFactIndexes.has(edge.successorFactIndex)) {
            joins.push(
                ` JOIN ${schema}.edge e${edge.edgeIndex}` +
                ` ON e${edge.edgeIndex}.successor_fact_id = f${edge.successorFactIndex}.fact_id` +
                ` AND e${edge.edgeIndex}.role_id = $${edge.roleParameter}`
            );
            joins.push(
                ` JOIN ${schema}.fact f${edge.predecessorFactIndex}` +
                ` ON f${edge.predecessorFactIndex}.fact_id = e${edge.edgeIndex}.predecessor_fact_id`
            );
            writtenFactIndexes.add(edge.predecessorFactIndex);
        }
        else {
            throw new Error("Neither predecessor nor successor fact has been written");
        }
    });
    return joins;
}

function generateNotExistsWhereClause(schema: string, notExistsWhereClause: ExistentialConditionDescription, outerFactIndexes: Set<number>): string {
    const firstEdge = notExistsWhereClause.edges[0];
    const writtenFactIndexes = new Set<number>(outerFactIndexes);
    const firstJoin: string[] = [];
    const whereClause: string[] = [];
    if (writtenFactIndexes.has(firstEdge.predecessorFactIndex)) {
        if (writtenFactIndexes.has(firstEdge.successorFactIndex)) {
            // An identity condition can bind the condition's own unknown to a
            // fact the enclosing scope has already written, which leaves the
            // first edge joining two written facts. Correlate on both and join
            // no new fact, as generateJoins does for a later edge.
            whereClause.push(
                `e${firstEdge.edgeIndex}.predecessor_fact_id = f${firstEdge.predecessorFactIndex}.fact_id` +
                ` AND e${firstEdge.edgeIndex}.successor_fact_id = f${firstEdge.successorFactIndex}.fact_id` +
                ` AND e${firstEdge.edgeIndex}.role_id = $${firstEdge.roleParameter}`
            );
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
    const conditionGivenFactIndexes = new Set<number>(notExistsWhereClause.inputs.map(input => input.factIndex));
    const tailJoins: string[] = generateJoins(schema, notExistsWhereClause.edges.slice(1), writtenFactIndexes, conditionGivenFactIndexes);
    const joins = firstJoin.concat(tailJoins);
    const inputWhereClauses = notExistsWhereClause.inputs
        .map(input => ` AND f${input.factIndex}.fact_type_id = $${input.factTypeParameter} AND f${input.factIndex}.hash = $${input.factHashParameter}`)
        .join("");
    const factEqualityWhereClauses = factEqualityClauses(notExistsWhereClause.factEqualities);
    const nestedExistsWhereClauses = notExistsWhereClause.existentialConditions
        .map(nested => ` AND ${nested.exists ? "EXISTS" : "NOT EXISTS"} (${generateNotExistsWhereClause(schema, nested, writtenFactIndexes)})`)
        .join("");
    return `SELECT 1 FROM ${schema}.edge e${firstEdge.edgeIndex}${joins.join("")} WHERE ${whereClause.join(" AND ")}${inputWhereClauses}${factEqualityWhereClauses}${nestedExistsWhereClauses}`;
}

function parseBookmark(bookmark: string): number[] {
    // The spelling of a bookmark is read in one place, src/util/bookmark.ts,
    // so that a reader comparing two bookmarks orders them the way this
    // query pages them.
    const positions = parseBookmarkPositions(bookmark);
    if (positions === null) {
        throw new Error(`Invalid bookmark: "${bookmark}"`);
    }
    return positions;
}

export function sqlFromSpecification(start: FactReference[], schema: string, bookmarks: string[], limit: number, specification: Specification, factTypes: Map<string, number>, roleMap: Map<number, Map<string, number>>): SpecificationSqlQuery[] {
    validateGiven(start, specification);

    const labeledStart = start.map((s, index) => ({
        name: specification.given[index].label.name,
        reference: s
    })).reduce((map, s) => {
        map.set(s.name, s.reference);
        return map;
    }, new Map<string, FactReference>());

    const feeds = buildFeeds(specification);
    const queryDescriptionBuilder = new QueryDescriptionBuilder(factTypes, roleMap);
    const feedAndBookmark = feeds.map((feed, index) => ({
        feed,
        bookmark: bookmarks[index]
    }));
    const queryDescriptionsAndBookmarks = feedAndBookmark.map(fb => {
        const feedStart = fb.feed.given.map(s => labeledStart.get(s.label.name)!);
        return {
            queryDescription: buildQueryDescription(queryDescriptionBuilder, fb.feed, feedStart, specification.given),
            bookmark: fb.bookmark
        };
    });
    const satisfiableQueryDescriptionsAndBookmarks = queryDescriptionsAndBookmarks.filter(qb =>
        qb.queryDescription.isSatisfiable());
    const sqlQueries = satisfiableQueryDescriptionsAndBookmarks.map(qdb =>
        generateSqlQuery(qdb.queryDescription, schema, qdb.bookmark, limit));
    return sqlQueries;
}

export function sqlFromFeed(feed: Specification, start: FactReference[], schema: string, bookmark: string, limit: number, factTypes: Map<string, number>, roleMap: Map<number, Map<string, number>>): SpecificationSqlQuery | null {
    const queryDescriptionBuilder = new QueryDescriptionBuilder(factTypes, roleMap);
    const queryDescription = buildQueryDescription(queryDescriptionBuilder, feed, start);
    if (!queryDescription.isSatisfiable()) {
        return null;
    }
    const sql = generateSqlQuery(queryDescription, schema, bookmark, limit);
    return sql;
}

function buildQueryDescription(queryDescriptionBuilder: QueryDescriptionBuilder, specification: Specification, start: FactReference[], originalGiven?: any[]): QueryDescription {
    const labels = specification.given.map(g => g.label);
    let knownFacts = {};
    
    // Process main matches
    let { queryDescription, knownFacts: updatedKnownFacts } = queryDescriptionBuilder.addEdges(
        QueryDescription.unsatisfiable,
        labels,
        start,
        knownFacts,
        [],
        specification.matches);
    knownFacts = updatedKnownFacts;
    
    // Process conditions from given (use originalGiven if provided, otherwise use specification.given)
    const givenToProcess = originalGiven || specification.given;
    for (const givenItem of givenToProcess) {
        if (givenItem.conditions && givenItem.conditions.length > 0) {
            for (const condition of givenItem.conditions) {
                const { query: queryDescriptionWithExistential, path: conditionalPath } = queryDescription.withExistentialCondition(condition.exists, []);
                const { queryDescription: queryDescriptionConditional, knownFacts: updatedKnownFacts } = queryDescriptionBuilder.addEdges(queryDescriptionWithExistential, labels, start, knownFacts, conditionalPath, condition.matches);
                
                if (queryDescriptionConditional.isSatisfiable()) {
                    queryDescription = queryDescriptionConditional;
                    knownFacts = updatedKnownFacts;
                }
            }
        }
    }
    
    return queryDescription;
}