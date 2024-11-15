import {
    buildFeeds,
    FactReference,
    Specification,
    validateGiven
} from "jinaga";

import { EdgeDescription, ExistentialConditionDescription, QueryDescription, QueryDescriptionBuilder } from "./query-description";

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
    const joins: string[] = generateJoins(schema, queryDescription.edges, writtenFactIndexes);
    const inputWhereClauses = queryDescription.inputs
        .filter(input => input.factTypeParameter !== 0)
        .map(input => `f${input.factIndex}.fact_type_id = $${input.factTypeParameter} AND f${input.factIndex}.hash = $${input.factHashParameter}`)
        .join(" AND ");
    const notExistsWhereClauses = (queryDescription.existentialConditions
        .filter(c => c.exists === false))
        .map(notExistsWhereClause => ` AND NOT EXISTS (${generateNotExistsWhereClause(schema, notExistsWhereClause, writtenFactIndexes)})`)
        .join("");
    const bookmarkParameter = queryDescription.parameters.length + 1;
    const limitParameter = bookmarkParameter + 1;
    const sql = `SELECT ${hashes}, sort(array[${factIds}], 'desc') as bookmark FROM ${schema}.fact f${firstFactIndex}${joins.join("")} WHERE ${inputWhereClauses}${notExistsWhereClauses} AND sort(array[${factIds}], 'desc') > $${bookmarkParameter} ORDER BY bookmark ASC LIMIT $${limitParameter}`;
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

function generateJoins(schema: string, edges: EdgeDescription[], writtenFactIndexes: Set<number>) {
    const joins: string[] = [];
    edges.forEach(edge => {
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
    const tailJoins: string[] = generateJoins(schema, notExistsWhereClause.edges.slice(1), writtenFactIndexes);
    const joins = firstJoin.concat(tailJoins);
    return `SELECT 1 FROM ${schema}.edge e${firstEdge.edgeIndex}${joins.join("")} WHERE ${whereClause.join(" AND ")}`;
}

function parseBookmark(bookmark: string): number[] {
    try {
        if (bookmark === undefined || bookmark === null || bookmark === "") {
            return [];
        }
        else {
            return bookmark.split(".").map(str => strictParseInt(str));
        }
    }
    catch (e) {
        throw new Error(`Invalid bookmark: "${bookmark}"`);
    }

    function strictParseInt(str: string): number {
        const parsed = parseInt(str);
        if (isNaN(parsed)) {
            throw new Error("NaN");
        }
        return parsed;
    }
}

export function sqlFromSpecification(start: FactReference[], schema: string, bookmarks: string[], limit: number, specification: Specification, factTypes: Map<string, number>, roleMap: Map<number, Map<string, number>>): SpecificationSqlQuery[] {
    validateGiven(start, specification);

    const labeledStart = start.map((s, index) => ({
        name: specification.given[index].name,
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
        const feedStart = fb.feed.given.map(s => labeledStart.get(s.name)!);
        return {
            queryDescription: buildQueryDescription(queryDescriptionBuilder, fb.feed, feedStart),
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

function buildQueryDescription(queryDescriptionBuilder: QueryDescriptionBuilder, specification: Specification, start: FactReference[]): QueryDescription {
    const { queryDescription } = queryDescriptionBuilder.addEdges(
        QueryDescription.unsatisfiable,
        specification.given,
        start, {}, [],
        specification.matches);
    return queryDescription;
}