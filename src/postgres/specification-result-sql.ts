import {
    ComponentProjection,
    FactProjection,
    FactRecord,
    FactReference,
    FieldProjection,
    HashProjection,
    hydrateFromTree,
    Label,
    Match,
    PredecessorCollection,
    ProjectedResult,
    Projection,
    ReferencesByName,
    SingularProjection,
    Specification,
    SpecificationProjection
} from "jinaga";

import { FactTypeMap, RoleMap } from "./maps";
import { EdgeDescription, ExistentialConditionDescription, FactByLabel, InputDescription, QueryDescription, QueryDescriptionBuider, SpecificationSqlQuery } from "./query-description";

function generateResultSqlQuery(queryDescription: QueryDescription, schema: string): SpecificationSqlQuery {
    const allLabels = [ ...queryDescription.inputs, ...queryDescription.outputs ];
    const columns = allLabels
        .map(label => `f${label.factIndex}.hash as hash${label.factIndex}, f${label.factIndex}.fact_id as id${label.factIndex}, f${label.factIndex}.data as data${label.factIndex}`)
        .join(", ");
    const firstEdge = queryDescription.edges[0];
    const predecessorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.predecessorFactIndex);
    const successorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.successorFactIndex);
    const firstFactIndex = predecessorFact ? predecessorFact.factIndex : successorFact!.factIndex;
    const writtenFactIndexes = new Set<number>().add(firstFactIndex);
    const joins: string[] = generateJoins(queryDescription.edges, writtenFactIndexes, schema);
    const inputWhereClauses = queryDescription.inputs
        .map(input => `f${input.factIndex}.fact_type_id = $${input.factTypeParameter} AND f${input.factIndex}.hash = $${input.factHashParameter}`)
        .join(" AND ");
    const existentialWhereClauses = queryDescription.existentialConditions
        .map(existentialCondition => ` AND ${existentialCondition.exists ? "EXISTS" : "NOT EXISTS"} (${generateExistentialWhereClause(existentialCondition, writtenFactIndexes, schema)})`)
        .join("");
    const orderByClause = queryDescription.outputs
        .map(output => `f${output.factIndex}.fact_id ASC`)
        .join(", ");
    const sql = `SELECT ${columns} FROM ${schema}.fact f${firstFactIndex}${joins.join("")} WHERE ${inputWhereClauses}${existentialWhereClauses} ORDER BY ${orderByClause}`;
    return {
        sql,
        parameters: queryDescription.parameters,
        labels: allLabels.map(label => ({
            name: label.label,
            type: label.type,
            index: label.factIndex
        })),
        bookmark: "[]"
    };
}

export function existentialsWithInput(existentialConditions: ExistentialConditionDescription[], input: InputDescription, path: number[]): ExistentialConditionDescription[] {
    if (path.length === 1) {
        return existentialConditions.map((c, i) => i === path[0] ?
            {
                ...c,
                inputs: [...c.inputs, input]
            } :
            c
        );
    }
    else {
        return existentialConditions.map((c, i) => i === path[0] ?
            {
                ...c,
                existentialConditions: existentialsWithInput(c.existentialConditions, input, path.slice(1))
            } :
            c
        );
    }
}

export function existentialsWithEdge(existentialConditions: ExistentialConditionDescription[], edge: EdgeDescription, path: number[]): ExistentialConditionDescription[] {
    if (path.length === 1) {
        return existentialConditions.map((c, i) => i === path[0] ?
            {
                ...c,
                edges: [...c.edges, edge]
            } :
            c
        );
    }
    else {
        return existentialConditions.map((c, i) => i === path[0] ?
            {
                ...c,
                existentialConditions: existentialsWithEdge(c.existentialConditions, edge, path.slice(1))
            } :
            c
        );
    }
}

export function existentialsWithNewCondition(existentialConditions: ExistentialConditionDescription[], exists: boolean, path: number[]): { existentialConditions: ExistentialConditionDescription[]; path: number[]; } {
    if (path.length === 0) {
        path = [existentialConditions.length];
        existentialConditions = [
            ...existentialConditions,
            {
                exists: exists,
                inputs: [],
                edges: [],
                existentialConditions: []
            }
        ];
        return { existentialConditions: existentialConditions, path };
    }
    else {
        const { existentialConditions: newExistentialConditions, path: newPath } = existentialsWithNewCondition(existentialConditions[path[0]].existentialConditions, exists, path.slice(1));
        existentialConditions = existentialConditions.map((c, i) => i === path[0] ?
            {
                exists: c.exists,
                inputs: c.inputs,
                edges: c.edges,
                existentialConditions: newExistentialConditions
            } :
            c
        );
        path = [path[0], ...newPath];
        return { existentialConditions: existentialConditions, path };
    }
}

function generateJoins(edges: EdgeDescription[], writtenFactIndexes: Set<number>, schema: string) {
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

interface ResultDescription {
    queryDescription: QueryDescription;
    resultProjection: Projection;
    childResultDescriptions: NamedResultDescription[];
    givenTuple: ReferencesByName;
}

interface NamedResultDescription extends ResultDescription {
    name: string;
}

interface IdentifiedResults {
    factIds: number[];
    tuple: ReferencesByName;
    result: any;
}

interface ChildResults {
    parentFactIds: number[];
    results: ProjectedResult[];
}

export interface SqlQueryTree {
    sqlQuery: SpecificationSqlQuery;
    childQueries: NamedSqlQueryTree[];
}

interface NamedSqlQueryTree extends SqlQueryTree {
    name: string;
}

export interface ResultSetData {
    fields: { [field: string]: any };
    predecessors: PredecessorCollection;
}

export interface ResultSetFact {
    hash: string;
    factId: number;
    data: ResultSetData;
}

export interface ResultSetRow {
    [factIndex: number]: ResultSetFact;
}

export interface ResultSetTree {
    resultSet: ResultSetRow[];
    childResultSets: NamedResultSetTree[];
}

interface NamedResultSetTree extends ResultSetTree {
    name: string;
}

export class ResultComposer {
    constructor(
        private readonly sqlQuery: SpecificationSqlQuery,
        private readonly resultProjection: Projection,
        private readonly parentFactIdLength: number,
        private readonly givenTuple: ReferencesByName,
        private readonly childResultComposers: NamedResultComposer[]
    ) { }

    public getSqlQueries(): SqlQueryTree {
        const childQueries: NamedSqlQueryTree[] = [];
        for (const childResultComposer of this.childResultComposers) {
            childQueries.push(({
                name: childResultComposer.name,
                ...childResultComposer.resultComposer.getSqlQueries()
            }));
        }
        return {
            sqlQuery: this.sqlQuery,
            childQueries
        };
    }

    public findFactReferences(
        resultSets: ResultSetTree
    ): FactReference[] {
        let factReferences: FactReference[] = [];

        // Add the fact references for selected facts.
        const projection = this.resultProjection;
        if (projection.type === 'fact') {
            const projectionFactReferences = this.factReferencesForProjection(projection, resultSets);
            factReferences = factReferences.concat(projectionFactReferences);
        }

        // Add the fact references for composites.
        if (projection.type === 'composite') {
            for (const component of projection.components) {
                if (component.type === 'fact') {
                    const projectionFactReferences = this.factReferencesForProjection(component, resultSets);
                    factReferences = factReferences.concat(projectionFactReferences);
                }
            }
        }

        // Recursively add the fact references for child result sets.
        for (const childResultSet of resultSets.childResultSets) {
            const childResultComposer = this.childResultComposers.find(c =>
                c.name === childResultSet.name);
            if (childResultComposer) {
                const childFactReferences = childResultComposer.resultComposer
                    .findFactReferences(childResultSet);
                factReferences = factReferences.concat(childFactReferences);
            }
        }

        return factReferences;
    }

    private factReferencesForProjection(projection: FactProjection, resultSets: ResultSetTree) {
        const label = this.getLabel(projection.label);
        const factReferences = resultSets.resultSet.map(row => ({
            type: label.type,
            hash: row[label.index].hash
        }));
        return factReferences;
    }

    public compose(
        resultSets: ResultSetTree,
        factRecords: FactRecord[]
    ): ProjectedResult[] {
        const childResults = this.composeInternal(resultSets, factRecords);
        if (childResults.length === 0) {
            return [];
        }
        else {
            return childResults[0].results;
        }
    }

    private composeInternal(
        resultSets: ResultSetTree,
        factRecords: FactRecord[]
    ): ChildResults[] {
        const rows = resultSets.resultSet;
        if (rows.length === 0) {
            return [];
        }

        // Project all rows and their identifiers
        const identifiedResults: IdentifiedResults[] = rows.map(row => ({
            factIds: this.identifierOf(row),
            tuple: this.tupleOf(row),
            result: this.projectionOf(row, factRecords)
        }));

        // Compose child results
        for (const childResultComposer of this.childResultComposers) {
            const childResultSet = resultSets.childResultSets.find(childResultSet =>
                childResultSet.name === childResultComposer.name);
            if (!childResultSet) {
                const availableNames = resultSets.childResultSets.map(childResultSet => childResultSet.name);
                throw new Error(`Child result set ${childResultComposer.name} not found in (${availableNames.join(", ")})`);
            }
            const composedResults = childResultComposer.resultComposer.composeInternal(childResultSet, factRecords);

            // Add the child results
            let index = 0;
            for (const identifiedResult of identifiedResults) {
                let results: any[] = [];
                if (index < composedResults.length && idsEqual(identifiedResult.factIds, composedResults[index].parentFactIds)) {
                    results = composedResults[index].results;
                    index++;
                }
                identifiedResult.result = {
                    ...identifiedResult.result,
                    [childResultComposer.name]: results
                };
            }
        }

        // Group the results by their parent identifiers
        const childResults: ChildResults[] = [];
        let parentFactIds: number[] = identifiedResults[0].factIds.slice(0, this.parentFactIdLength);
        let results: ProjectedResult[] = [{
            tuple: identifiedResults[0].tuple,
            result: identifiedResults[0].result
        }];
        for (const identifiedResult of identifiedResults.slice(1)) {
            const nextParentFactIds = identifiedResult.factIds.slice(0, this.parentFactIdLength);
            if (idsEqual(nextParentFactIds, parentFactIds)) {
                results.push({
                    tuple: identifiedResult.tuple,
                    result: identifiedResult.result
                });
            }
            else {
                childResults.push({
                    parentFactIds,
                    results
                });
                parentFactIds = nextParentFactIds;
                results = [{
                    tuple: identifiedResult.tuple,
                    result: identifiedResult.result
                }];
            }
        }
        childResults.push({
            parentFactIds,
            results
        });
        return childResults;
    }

    private identifierOf(row: ResultSetRow): number[] {
        return this.sqlQuery.labels.map(label => row[label.index].factId);
    }

    private tupleOf(row: ResultSetRow): ReferencesByName {
        const tuple = this.sqlQuery.labels.reduce((acc, label) => ({
            ...acc,
            [label.name]: {
                type: label.type,
                hash: row[label.index].hash,
            }
        }), this.givenTuple);
        return tuple;
    }

    private projectionOf(row: ResultSetRow, factRecords: FactRecord[]): any {
        if (this.resultProjection.type === "field") {
            return this.fieldValue(this.resultProjection, row);
        }
        else if (this.resultProjection.type === "composite") {
            if (
                this.resultProjection.components.length === 0 &&
                this.childResultComposers.length === 0) {
                return this.sqlQuery.labels
                    .slice(this.parentFactIdLength)
                    .reduce((acc, label) => ({
                        ...acc,
                        [label.name]: row[label.index].data.fields
                    }), {})
            }
            else {
                return this.resultProjection.components.reduce((acc, component) => ({
                    ...acc,
                    [component.name]: this.elementValue(component, row, factRecords)
                }), {});
            }
        }
        else if (this.resultProjection.type === "hash") {
            return this.hashValue(this.resultProjection, row);
        }
        else if (this.resultProjection.type === "fact") {
            return this.factValue(this.resultProjection, row, factRecords);
        }
        else {
            const _exhaustiveCheck: never = this.resultProjection;
            throw new Error(`Unknown projection type ${(this.resultProjection as any).type}`);
        }
    }

    private elementValue(projection: ComponentProjection, row: ResultSetRow, factRecords: FactRecord[]): any {
        if (projection.type === "field") {
            const label = this.getLabel(projection.label);
            return row[label.index].data.fields[projection.field];
        }
        else if (projection.type === "hash") {
            const label = this.getLabel(projection.label);
            return row[label.index].hash;
        }
        else if (projection.type === "fact") {
            const label = this.getLabel(projection.label);
            const factReference = {
                type: label.type,
                hash: row[label.index].hash,
            };
            const [fact] = hydrateFromTree([factReference], factRecords);
            return fact;
        }
        else if (projection.type === "specification") {
            // This should have already been taken care of
            return null;
        }
        else {
            const _exhaustiveCheck: never = projection;
            throw new Error(`Unknown projection type ${(projection as any).type}`);
        }
    }

    private fieldValue(projection: FieldProjection, row: ResultSetRow): any {
        const label = this.getLabel(projection.label);
        return row[label.index].data.fields[projection.field];
    }

    private hashValue(projection: HashProjection, row: ResultSetRow): any {
        const label = this.getLabel(projection.label);
        return row[label.index].hash;
    }

    private factValue(projection: FactProjection, row: ResultSetRow, factRecords: FactRecord[]): any {
        const label = this.getLabel(projection.label);
        const factReference: FactReference = {
            type: label.type,
            hash: row[label.index].hash
        };
        const [fact] = hydrateFromTree([factReference], factRecords);
        return fact;
    }

    private getLabel(name: string) {
        const label = this.sqlQuery.labels.find(label => label.name === name);
        if (!label) {
            throw new Error(`Label ${name} not found. Known labels: ${this.sqlQuery.labels.map(label => label.name).join(", ")}`);
        }
        return label;
    }
}

interface NamedResultComposer {
    name: string;
    resultComposer: ResultComposer;
}

class ResultDescriptionBuilder {
    constructor(
        private queryDescriptionBuilder: QueryDescriptionBuider
    ) { }

    buildDescription(start: FactReference[], specification: Specification): ResultDescription {
        // Verify that the number of start facts equals the number of inputs
        if (start.length !== specification.given.length) {
            throw new Error(`The number of start facts (${start.length}) does not equal the number of inputs (${specification.given.length})`);
        }
        // Verify that the input type matches the start fact type
        for (let i = 0; i < start.length; i++) {
            if (start[i].type !== specification.given[i].type) {
                throw new Error(`The type of start fact ${i} (${start[i].type}) does not match the type of input ${i} (${specification.given[i].type})`);
            }
        }

        // The QueryDescription is an immutable data type.
        // Initialize it with the inputs and facts.
        // The DescriptionBuilder will branch at various points, and
        // build on the current query description along each branch.
        return this.createResultDescription(QueryDescription.unsatisfiable, specification.given, start, specification.matches, specification.projection, {}, []);
    }

    private createResultDescription(queryDescription: QueryDescription, given: Label[], start: FactReference[], matches: Match[], projection: Projection, knownFacts: FactByLabel, path: number[]): ResultDescription {
        const givenTuple = given.reduce((acc, label, index) => ({
            ...acc,
            [label.name]: start[index]
        }), {} as ReferencesByName);
        ({ queryDescription, knownFacts } = this.queryDescriptionBuilder.addEdges(queryDescription, given, start, knownFacts, path, matches));
        if (!queryDescription.isSatisfiable()) {
            // Abort the branch if the query is not satisfiable
            return {
                queryDescription,
                resultProjection: {
                    type: "composite",
                    components: []
                },
                childResultDescriptions: [],
                givenTuple
            }
        }
        const childResultDescriptions: NamedResultDescription[] = [];
        if (projection.type === "composite") {
            const specificationProjections = projection.components
                .filter(projection => projection.type === "specification") as ({ name: string } & SpecificationProjection)[];
            const singularProjections = projection.components
                .filter(projection => projection.type === "field" || projection.type === "hash" || projection.type === "fact") as ({ name: string } & SingularProjection)[];
            for (const child of specificationProjections) {
                const childResultDescription = this.createResultDescription(queryDescription, given, start, child.matches, child.projection, knownFacts, []);
                childResultDescriptions.push({
                    name: child.name,
                    ...childResultDescription
                });
            }
            return {
                queryDescription,
                resultProjection: {
                    type: "composite",
                    components: singularProjections
                },
                childResultDescriptions,
                givenTuple
            };
        }
        else {
            return {
                queryDescription,
                resultProjection: projection,
                childResultDescriptions: [],
                givenTuple
            }
        }
    }
}

function idsEqual(a: number[], b: number[]) {
    return a.every((value, index) => value === b[index]);
}

export function resultSqlFromSpecification(start: FactReference[], specification: Specification, factTypes: FactTypeMap, roleMap: RoleMap, schema: string): ResultComposer | null {
    const queryDescriptionBuilder = new QueryDescriptionBuider(factTypes, roleMap);
    const descriptionBuilder = new ResultDescriptionBuilder(queryDescriptionBuilder);
    const description = descriptionBuilder.buildDescription(start, specification);

    if (!description.queryDescription.isSatisfiable()) {
        return null;
    }
    return createResultComposer(description, start.length, schema);
}

function createResultComposer(description: ResultDescription, parentFactIdLength: number, schema: string): ResultComposer {
    const sqlQuery = generateResultSqlQuery(description.queryDescription, schema);
    const resultProjection = description.resultProjection;
    const childResultComposers = description.childResultDescriptions
        .filter(child => child.queryDescription.isSatisfiable())
        .map(child => ({
            name: child.name,
            resultComposer: createResultComposer(child, description.queryDescription.outputLength(), schema)
        }));
    return new ResultComposer(sqlQuery, resultProjection, parentFactIdLength, description.givenTuple, childResultComposers);
}
