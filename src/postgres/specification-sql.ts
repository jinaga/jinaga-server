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
import {
    EdgeDescription,
    FactDescription,
    InputDescription,
    NotExistsConditionDescription,
    OutputDescription,
    QueryDescription,
    SpecificationSqlQuery,
} from "./query-description";
import { QueryDescriptionBuilder } from "./query-description-builder";

class DescriptionBuilder extends QueryDescriptionBuilder {
    constructor(
        factTypes: FactTypeMap,
        roleMap: RoleMap
    ) { super(factTypes, roleMap); }

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
        const facts: FactDescription[] = feed.facts.map(fact => ({
            type: fact.factType,
            factIndex: fact.factIndex
        }));

        return new QueryDescription(
            inputs,
            parameters,
            outputs,
            facts,
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
            label: `f${input.factIndex}`,
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
            label: `f${output.factIndex}`,
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

export function sqlFromSpecification(start: FactReference[], bookmarks: string[], limit: number, specification: Specification, factTypes: Map<string, number>, roleMap: Map<number, Map<string, number>>): SpecificationSqlQuery[] {
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
        const sql = description.generateSqlQuery(fb.bookmark, limit);
        return sql;
    });
    return sqlQueries;
}
