import {
    buildFeeds,
    EdgeDescription as FeedEdgeDescription,
    FactReference,
    Feed,
    InputDescription as FeedInputDescription,
    NotExistsConditionDescription as FeedNotExistsConditionDescription,
    OutputDescription as FeedOutputDescription,
    Specification,
} from "jinaga";

import { FactTypeMap, getFactTypeId, getRoleId, RoleMap } from "./maps";

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

interface InputDescription {
    factIndex: number;
    factTypeId: number;
    factHash: string;
    factTypeParameter: number;
    factHashParameter: number;
}
interface OutputDescription {
    type: string;
    factIndex: number;
}
interface EdgeDescription {
    edgeIndex: number;
    predecessorFactIndex: number;
    successorFactIndex: number;
    roleParameter: number;
}
interface NotExistsConditionDescription {
    edges: EdgeDescription[];
    notExistsConditions: NotExistsConditionDescription[];
}
class QueryDescription {
    constructor(
        private readonly inputs: InputDescription[],
        private readonly parameters: (string | number)[],
        private readonly outputs: OutputDescription[],
        private readonly edges: EdgeDescription[],
        private readonly notExistsConditions: NotExistsConditionDescription[] = []
    ) {}

    generateSqlQuery(schema: string, bookmark: string, limit: number): SpecificationSqlQuery {
        const hashes = this.outputs
            .map(output => `f${output.factIndex}.hash as hash${output.factIndex}`)
            .join(", ");
        const factIds = this.outputs
            .map(output => `f${output.factIndex}.fact_id`)
            .join(", ");
        const firstEdge = this.edges[0];
        const predecessorFact = this.inputs.find(i => i.factIndex === firstEdge.predecessorFactIndex);
        const successorFact = this.inputs.find(i => i.factIndex === firstEdge.successorFactIndex);
        const firstFactIndex = predecessorFact ? predecessorFact.factIndex : successorFact!.factIndex;
        const writtenFactIndexes = new Set<number>().add(firstFactIndex);
        const joins: string[] = generateJoins(schema, this.edges, writtenFactIndexes);
        const inputWhereClauses = this.inputs
            .filter(input => input.factTypeParameter !== 0)
            .map(input => `f${input.factIndex}.fact_type_id = $${input.factTypeParameter} AND f${input.factIndex}.hash = $${input.factHashParameter}`)
            .join(" AND ");
        const notExistsWhereClauses = this.notExistsConditions
            .map(notExistsWhereClause => ` AND NOT EXISTS (${generateNotExistsWhereClause(schema, notExistsWhereClause, writtenFactIndexes)})`)
            .join("");
        const bookmarkParameter = this.parameters.length + 1;
        const limitParameter = bookmarkParameter + 1;
        const sql = `SELECT ${hashes}, sort(array[${factIds}], 'desc') as bookmark FROM ${schema}.fact f${firstFactIndex}${joins.join("")} WHERE ${inputWhereClauses}${notExistsWhereClauses} AND sort(array[${factIds}], 'desc') > $${bookmarkParameter} ORDER BY bookmark ASC LIMIT $${limitParameter}`;
        const bookmarkValue: number[] = parseBookmark(bookmark);
        return {
            sql,
            parameters: [...this.parameters, bookmarkValue, limit],
            labels: this.outputs.map(output => ({
                type: output.type,
                index: output.factIndex
            })),
            bookmark: "[]"
        };
    }
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

function generateNotExistsWhereClause(schema: string, notExistsWhereClause: NotExistsConditionDescription, outerFactIndexes: Set<number>): string {
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

class DescriptionBuilder {
    constructor(
        private factTypes: FactTypeMap,
        private roleMap: RoleMap
    ) { }

    isSatisfiable(feed: Feed, edges: FeedEdgeDescription[]): boolean {
        for (const edge of edges) {
            const successor = feed.facts.find(f => f.factIndex === edge.successorFactIndex);
            if (!successor) {
                return false;
            }

            const predecessor = feed.facts.find(f => f.factIndex === edge.predecessorFactIndex);
            if (!predecessor) {
                return false;
            }

            const successorFactTypeId = getFactTypeId(this.factTypes, successor.factType);
            if (!successorFactTypeId) {
                return false;
            }

            if (!getRoleId(this.roleMap, successorFactTypeId, edge.roleName)) {
                return false;
            }

            const predecessorFactTypeId = getFactTypeId(this.factTypes, predecessor.factType);
            if (!predecessorFactTypeId) {
                return false;
            }
        }

        return true;
    }

    buildDescription(feed: Feed): QueryDescription {
        const parameters: (string | number)[] = [];
        function addParameter(value: string | number) {
            parameters.push(value);
            return parameters.length;
        }

        // Allocate parameters for the inputs.
        const inputs: InputDescription[] = feed.inputs.map(input =>
            this.buildInputDescription(feed, input, addParameter)
        );

        // Allocate parameters for the edge roles.
        const edges: EdgeDescription[] = feed.edges.map(edge =>
            this.buildEdgeDescription(feed, edge, addParameter)
        );

        // Allocate parameters for the conditional roles.
        const satisfiableNotExistsConditions = feed.notExistsConditions.filter(condition =>
            this.isSatisfiable(feed, condition.edges)
        );
        const notExistsConditions: NotExistsConditionDescription[] = satisfiableNotExistsConditions.map(condition =>
            this.buildNotExistsConditionDescription(feed, condition, addParameter)
        );

        const outputs: OutputDescription[] = feed.outputs.map(output =>
            this.buildOutputDescription(feed, output)
        );

        return new QueryDescription(
            inputs,
            parameters,
            outputs,
            edges,
            notExistsConditions
        );
    }

    private buildInputDescription(feed: Feed, input: FeedInputDescription, addParameter: (value: string | number) => number): InputDescription {
        const fact = feed.facts.find(f => f.factIndex === input.factIndex);
        if (!fact) {
            throw new Error(`Fact not found: ${input.factIndex}`);
        }

        const factTypeId = getFactTypeId(this.factTypes, fact.factType);
        if (!factTypeId) {
            throw new Error(`Fact type not found: ${fact.factType}`);
        }

        const factTypeParameter = addParameter(factTypeId);
        const factHashParameter = addParameter(input.factHash);
        return {
            factIndex: input.factIndex,
            factTypeId,
            factTypeParameter,
            factHash: input.factHash,
            factHashParameter
        };
    }

    private buildEdgeDescription(feed: Feed, edge: FeedEdgeDescription, addParameter: (value: string | number) => number) {
        const fact = feed.facts.find(f => f.factIndex === edge.successorFactIndex);
        if (!fact) {
            throw new Error(`Fact not found: ${edge.successorFactIndex}`);
        }

        const factTypeId = getFactTypeId(this.factTypes, fact.factType);
        if (!factTypeId) {
            throw new Error(`Fact type not found: ${fact.factType}`);
        }

        const roleId = getRoleId(this.roleMap, factTypeId, edge.roleName);
        if (!roleId) {
            throw new Error(`Role not found: ${fact.factType}.${edge.roleName}`);
        }

        const roleParameter = addParameter(roleId);
        return <EdgeDescription>{
            edgeIndex: edge.edgeIndex,
            predecessorFactIndex: edge.predecessorFactIndex,
            successorFactIndex: edge.successorFactIndex,
            roleParameter
        };
    }

    private buildOutputDescription(feed: Feed, output: FeedOutputDescription) {
        const fact = feed.facts.find(f => f.factIndex === output.factIndex);
        if (!fact) {
            throw new Error(`Fact not found: ${output.factIndex}`);
        }

        return <OutputDescription>{
            factIndex: output.factIndex,
            type: fact.factType
        };
    }

    private buildNotExistsConditionDescription(feed: Feed, condition: FeedNotExistsConditionDescription, addParameter: (value: string | number) => number): NotExistsConditionDescription {
        const edges = condition.edges.map(edge =>
            this.buildEdgeDescription(feed, edge, addParameter)
        );
        const notExistsConditions = condition.notExistsConditions.map(condition =>
            this.buildNotExistsConditionDescription(feed, condition, addParameter)
        );

        return {
            edges,
            notExistsConditions
        }
    }
}

export function sqlFromSpecification(start: FactReference[], schema: string, bookmarks: string[], limit: number, specification: Specification, factTypes: Map<string, number>, roleMap: Map<number, Map<string, number>>): SpecificationSqlQuery[] {
    const feeds = buildFeeds(start, specification);
    const descriptionBuilder = new DescriptionBuilder(factTypes, roleMap);
    const feedAndBookmark = feeds.map((feed, index) => ({
        feed,
        bookmark: bookmarks[index]
    }));
    const satisfiableFeedsAndBookmarks = feedAndBookmark.filter(fb =>
        descriptionBuilder.isSatisfiable(fb.feed, fb.feed.edges));
    const sqlQueries = satisfiableFeedsAndBookmarks.map(fb => {
        const description = descriptionBuilder.buildDescription(fb.feed);
        const sql = description.generateSqlQuery(schema, fb.bookmark, limit);
        return sql;
    });
    return sqlQueries;
}

export function sqlFromFeed(feed: Feed, schema: string, bookmark: string, limit: number, factTypes: Map<string, number>, roleMap: Map<number, Map<string, number>>): SpecificationSqlQuery | null {
    const descriptionBuilder = new DescriptionBuilder(factTypes, roleMap);
    if (!descriptionBuilder.isSatisfiable(feed, feed.edges)) {
        return null;
    }
    const description = descriptionBuilder.buildDescription(feed);
    const sql = description.generateSqlQuery(schema, bookmark, limit);
    return sql;
}
