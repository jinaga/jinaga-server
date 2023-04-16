import {
    ComponentProjection,
    FactProjection,
    FactReference,
    FieldProjection,
    HashProjection,
    Label,
    Match,
    PathCondition,
    PredecessorCollection,
    ProjectedResult,
    Projection,
    ReferencesByName,
    SingularProjection,
    Specification,
    SpecificationProjection
} from "jinaga";

import { ensureGetFactTypeId, FactTypeMap, getFactTypeId, getRoleId, RoleMap } from "./maps";

interface SpecificationLabel {
    name: string;
    index: number;
    type: string;
}
interface FactDescription {
    type: string;
    factIndex: number;
}
interface EdgeDescription {
    edgeIndex: number;
    predecessorFactIndex: number;
    successorFactIndex: number;
    roleParameter: number;
}
interface ExistentialConditionDescription {
    exists: boolean;
    inputs: InputDescription[];
    edges: EdgeDescription[];
    existentialConditions: ExistentialConditionDescription[];
}
interface SpecificationSqlQuery {
    sql: string;
    parameters: (string | number | number[])[];
    labels: SpecificationLabel[];
    bookmark: string;
};
interface InputDescription {
    label: string;
    factIndex: number;
    factTypeParameter: number;
    factHashParameter: number;
}
interface OutputDescription {
    label: string;
    type: string;
    factIndex: number;
}

function countEdges(existentialConditions: ExistentialConditionDescription[]): number {
    return existentialConditions.reduce((count, c) => count + c.edges.length + countEdges(c.existentialConditions),
        0);
}

class QueryDescription {
    // An unsatisfiable query description will produce no results.
    static unsatisfiable: QueryDescription = new QueryDescription(
        [], [], [], [], [], []
    );

    constructor(
        private readonly inputs: InputDescription[],
        private readonly parameters: (string | number)[],
        private readonly outputs: OutputDescription[],
        private readonly facts: FactDescription[],
        private readonly edges: EdgeDescription[],
        private readonly existentialConditions: ExistentialConditionDescription[] = []
    ) {}

    public withParameter(parameter: string | number): { query: QueryDescription; parameterIndex: number; } {
        const parameterIndex = this.parameters.length + 1;
        const query = new QueryDescription(
            this.inputs,
            this.parameters.concat(parameter),
            this.outputs,
            this.facts,
            this.edges,
            this.existentialConditions
        );
        return { query, parameterIndex };
    }

    public withInputParameter(label: Label, factTypeId: number, factHash: string, path: number[]): { queryDescription: QueryDescription, factDescription: FactDescription } {
        const factTypeParameter = this.parameters.length + 1;
        const factHashParameter = factTypeParameter + 1;
        const factIndex = this.facts.length + 1;
        const factDescription: FactDescription = {
            factIndex: factIndex,
            type: label.type
        };
        const facts = [
            ...this.facts,
            factDescription
        ]
        const input: InputDescription = {
            label: label.name,
            factIndex,
            factTypeParameter,
            factHashParameter
        };
        const parameters = this.parameters.concat(factTypeId, factHash);
        if (path.length === 0) {
            const inputs = [
                ...this.inputs,
                input
            ];
            const queryDescription = new QueryDescription(
                inputs,
                parameters,
                this.outputs,
                facts,
                this.edges,
                this.existentialConditions
            );
            return { queryDescription, factDescription };
        }
        else {
            const existentialConditions = existentialsWithInput(this.existentialConditions, input, path);
            const queryDescription = new QueryDescription(
                this.inputs,
                parameters,
                this.outputs,
                facts,
                this.edges,
                existentialConditions
            );
            return { queryDescription, factDescription };
        }
    }

    public withFact(type: string): { query: QueryDescription; factIndex: number; } {
        const factIndex = this.facts.length + 1;
        const fact = { factIndex, type };
        const query = new QueryDescription(
            this.inputs,
            this.parameters,
            this.outputs,
            this.facts.concat(fact),
            this.edges,
            this.existentialConditions
        );
        return { query, factIndex };
    }

    public withOutput(label: string, type: string, factIndex: number): QueryDescription {
        const output = { label, type, factIndex };
        const query = new QueryDescription(
            this.inputs,
            this.parameters,
            this.outputs.concat(output),
            this.facts,
            this.edges,
            this.existentialConditions
        );
        return query;
    }

    public withEdge(predecessorFactIndex: number, successorFactIndex: number, roleParameter: number, path: number[]) {
        const edge = {
            edgeIndex: this.edges.length + countEdges(this.existentialConditions) + 1,
            predecessorFactIndex,
            successorFactIndex,
            roleParameter
        };
        const query = (path.length === 0)
            ? new QueryDescription(
                this.inputs,
                this.parameters,
                this.outputs,
                this.facts,
                this.edges.concat(edge),
                this.existentialConditions
            )
            : new QueryDescription(
                this.inputs,
                this.parameters,
                this.outputs,
                this.facts,
                this.edges,
                existentialsWithEdge(this.existentialConditions, edge, path)
            );
        return query;
    }

    public withExistentialCondition(exists: boolean, path: number[]): { query: QueryDescription; path: number[]; } {
        const { existentialConditions: newExistentialConditions, path: newPath } = existentialsWithNewCondition(this.existentialConditions, exists, path);
        const query = new QueryDescription(
            this.inputs,
            this.parameters,
            this.outputs,
            this.facts,
            this.edges,
            newExistentialConditions
        );
        return { query, path: newPath };
    }

    isSatisfiable() {
        return this.inputs.length > 0;
    }

    hasOutput(label: string) {
        return this.outputs.some(o => o.label === label);
    }

    inputByLabel(label: string): InputDescription | undefined {
        return this.inputs.find(i => i.label === label);
    }

    outputLength(): number {
        return this.outputs.length;
    }

    generateResultSqlQuery(schema: string): SpecificationSqlQuery {
        const columns = this.outputs
            .map(output => `f${output.factIndex}.hash as hash${output.factIndex}, f${output.factIndex}.fact_id as id${output.factIndex}, f${output.factIndex}.data as data${output.factIndex}`)
            .join(", ");
        const firstEdge = this.edges[0];
        const predecessorFact = this.inputs.find(i => i.factIndex === firstEdge.predecessorFactIndex);
        const successorFact = this.inputs.find(i => i.factIndex === firstEdge.successorFactIndex);
        const firstFactIndex = predecessorFact ? predecessorFact.factIndex : successorFact!.factIndex;
        const writtenFactIndexes = new Set<number>().add(firstFactIndex);
        const joins: string[] = generateJoins(this.edges, writtenFactIndexes, schema);
        const inputWhereClauses = this.inputs
            .map(input => `f${input.factIndex}.fact_type_id = $${input.factTypeParameter} AND f${input.factIndex}.hash = $${input.factHashParameter}`)
            .join(" AND ");
        const existentialWhereClauses = this.existentialConditions
            .map(existentialCondition => ` AND ${existentialCondition.exists ? "EXISTS" : "NOT EXISTS"} (${generateExistentialWhereClause(existentialCondition, writtenFactIndexes, schema)})`)
            .join("");
        const orderByClause = this.outputs
            .map(output => `f${output.factIndex}.fact_id ASC`)
            .join(", ");
        const sql = `SELECT ${columns} FROM ${schema}.fact f${firstFactIndex}${joins.join("")} WHERE ${inputWhereClauses}${existentialWhereClauses} ORDER BY ${orderByClause}`;
        return {
            sql,
            parameters: this.parameters,
            labels: this.outputs.map(output => ({
                name: output.label,
                type: output.type,
                index: output.factIndex
            })),
            bookmark: "[]"
        };
    }
}

function existentialsWithInput(existentialConditions: ExistentialConditionDescription[], input: InputDescription, path: number[]): ExistentialConditionDescription[] {
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

function existentialsWithEdge(existentialConditions: ExistentialConditionDescription[], edge: EdgeDescription, path: number[]): ExistentialConditionDescription[] {
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

function existentialsWithNewCondition(existentialConditions: ExistentialConditionDescription[], exists: boolean, path: number[]): { existentialConditions: ExistentialConditionDescription[]; path: number[]; } {
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

type FactByLabel = {
    [label: string]: FactDescription;
};

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

    public compose(
        resultSets: ResultSetTree
    ): ProjectedResult[] {
        const childResults = this.composeInternal(resultSets);
        if (childResults.length === 0) {
            return [];
        }
        else {
            return childResults[0].results;
        }
    }

    private composeInternal(
        resultSets: ResultSetTree
    ): ChildResults[] {
        const rows = resultSets.resultSet;
        if (rows.length === 0) {
            return [];
        }

        // Project all rows and their identifiers
        const identifiedResults: IdentifiedResults[] = rows.map(row => ({
            factIds: this.identifierOf(row),
            tuple: this.tupleOf(row),
            result: this.projectionOf(row)
        }));

        // Compose child results
        for (const childResultComposer of this.childResultComposers) {
            const childResultSet = resultSets.childResultSets.find(childResultSet =>
                childResultSet.name === childResultComposer.name);
            if (!childResultSet) {
                const availableNames = resultSets.childResultSets.map(childResultSet => childResultSet.name);
                throw new Error(`Child result set ${childResultComposer.name} not found in (${availableNames.join(", ")})`);
            }
            const composedResults = childResultComposer.resultComposer.composeInternal(childResultSet);

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

    private projectionOf(row: ResultSetRow): any {
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
                    [component.name]: this.elementValue(component, row)
                }), {});
            }
        }
        else if (this.resultProjection.type === "hash") {
            return this.hashValue(this.resultProjection, row);
        }
        else if (this.resultProjection.type === "fact") {
            return this.factValue(this.resultProjection, row);
        }
        else {
            const _exhaustiveCheck: never = this.resultProjection;
            throw new Error(`Unknown projection type ${(this.resultProjection as any).type}`);
        }
    }

    private elementValue(projection: ComponentProjection, row: ResultSetRow): any {
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
            return row[label.index].data.fields;
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

    private factValue(projection: FactProjection, row: ResultSetRow): any {
        const label = this.getLabel(projection.label);
        return row[label.index].data.fields;
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
        private factTypes: FactTypeMap,
        private roleMap: RoleMap
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
        const initialQueryDescription = new QueryDescription([], [], [], [], [], []);
        return this.createResultDescription(initialQueryDescription, specification.given, start, specification.matches, specification.projection, {}, []);
    }

    private createResultDescription(queryDescription: QueryDescription, given: Label[], start: FactReference[], matches: Match[], projection: Projection, knownFacts: FactByLabel, path: number[]): ResultDescription {
        const givenTuple = given.reduce((acc, label, index) => ({
            ...acc,
            [label.name]: start[index]
        }), {} as ReferencesByName);
        ({ queryDescription, knownFacts } = this.addEdges(queryDescription, given, start, knownFacts, path, matches));
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

    private addEdges(queryDescription: QueryDescription, given: Label[], start: FactReference[], knownFacts: FactByLabel, path: number[], matches: Match[]): { queryDescription: QueryDescription, knownFacts: FactByLabel } {
        for (const match of matches) {
            for (const condition of match.conditions) {
                if (condition.type === "path") {
                    ({queryDescription, knownFacts} = this.addPathCondition(queryDescription, given, start, knownFacts, path, match.unknown, "", condition));
                }
                else if (condition.type === "existential") {
                    // Apply the where clause and continue with the tuple where it is true.
                    // The path describes which not-exists condition we are currently building on.
                    // Because the path is not empty, labeled facts will be included in the output.
                    const { query: queryDescriptionWithExistential, path: conditionalPath } = queryDescription.withExistentialCondition(condition.exists, path);
                    const { queryDescription: queryDescriptionConditional } = this.addEdges(queryDescriptionWithExistential, given, start, knownFacts, conditionalPath, condition.matches);

                    // If the negative existential condition is not satisfiable, then
                    // that means that the condition will always be true.
                    // We can therefore skip the branch for the negative existential condition.
                    if (queryDescriptionConditional.isSatisfiable()) {
                        queryDescription = queryDescriptionConditional;
                    }
                }
                if (!queryDescription.isSatisfiable()) {
                    break;
                }
            }
            if (!queryDescription.isSatisfiable()) {
                break;
            }
        }
        return {
            queryDescription,
            knownFacts
        };
    }

    private addPathCondition(queryDescription: QueryDescription, given: Label[], start: FactReference[], knownFacts: FactByLabel, path: number[], unknown: Label, prefix: string, condition: PathCondition): { queryDescription: QueryDescription, knownFacts: FactByLabel } {
        // If no input parameter has been allocated, allocate one now.
        if (!knownFacts.hasOwnProperty(condition.labelRight)) {
            const givenIndex = given.findIndex(given => given.name === condition.labelRight);
            if (givenIndex < 0) {
                throw new Error(`No input parameter found for label ${condition.labelRight}`);
            }
            const { queryDescription: newQueryDescription, factDescription } = queryDescription.withInputParameter(
                given[givenIndex],
                ensureGetFactTypeId(this.factTypes, start[givenIndex].type),
                start[givenIndex].hash,
                path
            );
            queryDescription = newQueryDescription;
            knownFacts = {
                ...knownFacts,
                [condition.labelRight]: factDescription
            };
        }

        // Determine whether we have already written the output.
        const knownFact = knownFacts[unknown.name];
        const roleCount = condition.rolesLeft.length + condition.rolesRight.length;

        // Walk up the right-hand side.
        // This generates predecessor joins from a given or prior label.
        let fact = knownFacts[condition.labelRight];
        if (!fact) {
            throw new Error(`Label ${condition.labelRight} not found. Known labels: ${Object.keys(knownFacts).join(", ")}`);
        }
        let type = fact.type;
        let factIndex = fact.factIndex;
        for (const [i, role] of condition.rolesRight.entries()) {
            // If the type or role is not known, then no facts matching the condition can
            // exist. The query is unsatisfiable.
            const typeId = getFactTypeId(this.factTypes, type);
            if (!typeId) {
                return { queryDescription: QueryDescription.unsatisfiable, knownFacts };
            }
            const roleId = getRoleId(this.roleMap, typeId, role.name);
            if (!roleId) {
                return { queryDescription: QueryDescription.unsatisfiable, knownFacts };
            }

            const { query: queryWithParameter, parameterIndex: roleParameter } = queryDescription.withParameter(roleId);
            if (i === roleCount - 1 && knownFact) {
                // If we have already written the output, we can use the fact index.
                queryDescription = queryWithParameter.withEdge(knownFact.factIndex, factIndex, roleParameter, path);
                factIndex = knownFact.factIndex;
            }
            else {
                // If we have not written the fact, we need to write it now.
                const { query, factIndex: predecessorFactIndex } = queryWithParameter.withFact(role.predecessorType);
                queryDescription = query.withEdge(predecessorFactIndex, factIndex, roleParameter, path);
                factIndex = predecessorFactIndex;
            }
            type = role.predecessorType;
        }

        const rightType = type;

        // Walk up the left-hand side.
        // We will need to reverse this walk to generate successor joins.
        type = unknown.type;
        const newEdges: {
            roleId: number;
            declaringType: string;
        }[] = [];
        for (const role of condition.rolesLeft) {
            // If the type or role is not known, then no facts matching the condition can
            // exist. The query is unsatisfiable.
            const typeId = getFactTypeId(this.factTypes, type);
            if (!typeId) {
                return { queryDescription: QueryDescription.unsatisfiable, knownFacts };
            }
            const roleId = getRoleId(this.roleMap, typeId, role.name);
            if (!roleId) {
                return { queryDescription: QueryDescription.unsatisfiable, knownFacts };
            }

            newEdges.push({
                roleId,
                declaringType: type
            });
            type = role.predecessorType;
        }

        if (type !== rightType) {
            throw new Error(`Type mismatch: ${type} is compared to ${rightType}`);
        }

        newEdges.reverse().forEach(({ roleId, declaringType }, i) => {
            const { query: queryWithParameter, parameterIndex: roleParameter } = queryDescription.withParameter(roleId);
            if (condition.rolesRight.length + i === roleCount - 1 && knownFact) {
                queryDescription = queryWithParameter.withEdge(factIndex, knownFact.factIndex, roleParameter, path);
                factIndex = knownFact.factIndex;
            }
            else {
                const { query: queryWithFact, factIndex: successorFactIndex } = queryWithParameter.withFact(declaringType);
                queryDescription = queryWithFact.withEdge(factIndex, successorFactIndex, roleParameter, path);
                factIndex = successorFactIndex;
            }
        });

        // If we have not captured the known fact, add it now.
        if (!knownFact) {
            knownFacts = { ...knownFacts, [unknown.name]: { factIndex, type: unknown.type } };
            // If we have not written the output, write it now.
            // Only write the output if we are not inside of an existential condition.
            // Use the prefix, which will be set for projections.
            if (path.length === 0) {
                queryDescription = queryDescription.withOutput(prefix + unknown.name, unknown.type, factIndex);
            }
        }
        return { queryDescription, knownFacts };
    }
}

function idsEqual(a: number[], b: number[]) {
    return a.every((value, index) => value === b[index]);
}

export function resultSqlFromSpecification(start: FactReference[], specification: Specification, factTypes: FactTypeMap, roleMap: RoleMap, schema: string): ResultComposer | null {
    const descriptionBuilder = new ResultDescriptionBuilder(factTypes, roleMap);
    const description = descriptionBuilder.buildDescription(start, specification);

    if (!description.queryDescription.isSatisfiable()) {
        return null;
    }
    return createResultComposer(description, 0, schema);
}

function createResultComposer(description: ResultDescription, parentFactIdLength: number, schema: string): ResultComposer {
    const sqlQuery = description.queryDescription.generateResultSqlQuery(schema);
    const resultProjection = description.resultProjection;
    const childResultComposers = description.childResultDescriptions
        .filter(child => child.queryDescription.isSatisfiable())
        .map(child => ({
            name: child.name,
            resultComposer: createResultComposer(child, description.queryDescription.outputLength(), schema)
        }));
    return new ResultComposer(sqlQuery, resultProjection, parentFactIdLength, description.givenTuple, childResultComposers);
}
