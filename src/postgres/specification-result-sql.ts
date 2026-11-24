import {
    ComponentProjection,
    FactProjection,
    FactRecord,
    FactReference,
    FieldProjection,
    HashProjection,
    hydrateFromTree,
    Match,
    PredecessorCollection,
    ProjectedResult,
    Projection,
    ReferencesByName,
    SingularProjection,
    Specification,
    SpecificationGiven,
    SpecificationProjection,
    TimeProjection,
    validateGiven
} from "jinaga";

import { FactTypeMap, RoleMap } from "./maps";
import { EdgeDescription, ExistentialConditionDescription, FactByLabel, FactEqualityDescription, QueryDescription, QueryDescriptionBuilder } from "./query-description";

/**
 * The facts a read must not find beneath a negative existential condition.
 *
 * `readAsIfSaved` writes the staged facts into a transaction that it rolls
 * back. Beneath a negative existential condition, at any depth, a successor
 * walk reads only the facts the store held before the batch, so each fact such
 * a walk joins excludes the staged ids. A predecessor walk does not: it reads a
 * staged fact's own predecessors, so a condition that joins through the fact a
 * match found still reaches the witnesses saved beneath it. A saved fact never
 * has a staged predecessor, so that withdraws no witness the store holds.
 */
interface StagedExclusion {
    parameter: number;
    used: boolean;
}

function excludeStaged(factIndex: number, exclusion: StagedExclusion | undefined): string {
    if (!exclusion) {
        return "";
    }
    exclusion.used = true;
    return ` AND f${factIndex}.fact_id <> ALL($${exclusion.parameter}::integer[])`;
}

// The exclusion that applies inside a condition: none until the first
// negative condition, and from there down, at every depth, the staged ids.
function exclusionWithin(exists: boolean, outer: StagedExclusion | undefined, staged: StagedExclusion | undefined) {
    return outer ?? (exists ? undefined : staged);
}

// An identity condition between two labels that are both already bound
// compares the two facts in the scope where the condition appears. Both fact
// indexes are written by the joins of that scope, or of one enclosing it,
// before the WHERE clause is evaluated.
function factEqualityClauses(factEqualities: FactEqualityDescription[]): string {
    return factEqualities
        .map(equality => ` AND f${equality.leftFactIndex}.fact_id = f${equality.rightFactIndex}.fact_id`)
        .join("");
}

function generateResultSqlQuery(queryDescription: QueryDescription, schema: string, stagedFactIds: number[]): SpecificationSqlQuery {
    const parameters: (string | number | number[])[] = [ ...queryDescription.parameters ];
    const staged: StagedExclusion | undefined = stagedFactIds.length > 0
        ? { parameter: parameters.length + 1, used: false }
        : undefined;
    const allLabels = [ ...queryDescription.inputs, ...queryDescription.outputs ];
    const columns = allLabels
        .map(label => `f${label.factIndex}.hash as hash${label.factIndex}, f${label.factIndex}.fact_id as id${label.factIndex}, f${label.factIndex}.data as data${label.factIndex}, f${label.factIndex}.date_learned as timestamp${label.factIndex}`)
        .join(", ");
    const { firstFactIndex, joins, writtenFactIndexes } = queryDescription.edges.length > 0
        ? joinEdges(queryDescription, schema)
        : joinGivens(queryDescription, schema);
    // Add all input fact indexes to writtenFactIndexes since they're available in the FROM clause
    queryDescription.inputs.forEach(input => writtenFactIndexes.add(input.factIndex));
    const inputWhereClauses = queryDescription.inputs
        .map(input => `f${input.factIndex}.fact_type_id = $${input.factTypeParameter} AND f${input.factIndex}.hash = $${input.factHashParameter}`)
        .join(" AND ");
    const factEqualityWhereClauses = factEqualityClauses(queryDescription.factEqualities);
    const existentialWhereClauses = queryDescription.existentialConditions
        .map(existentialCondition => ` AND ${existentialCondition.exists ? "EXISTS" : "NOT EXISTS"} (${generateExistentialWhereClause(existentialCondition, writtenFactIndexes, schema, staged, exclusionWithin(existentialCondition.exists, undefined, staged))})`)
        .join("");
    // With no outputs, every column is a given: the givens are fixed by type
    // and hash, so the query returns at most one row and has nothing to order.
    const orderByClause = queryDescription.outputs.length > 0
        ? " ORDER BY " + queryDescription.outputs
            .map(output => `f${output.factIndex}.fact_id ASC`)
            .join(", ")
        : "";
    const sql = `SELECT ${columns} FROM ${schema}.fact f${firstFactIndex}${joins.join("")} WHERE ${inputWhereClauses}${factEqualityWhereClauses}${existentialWhereClauses}${orderByClause}`;
    // Bind the staged ids only if a negative condition refers to them: an
    // unreferenced parameter is an error in Postgres.
    if (staged && staged.used) {
        parameters.push(stagedFactIds);
    }
    return {
        sql,
        parameters,
        labels: allLabels.map(label => ({
            name: label.label,
            type: label.type,
            index: label.factIndex
        })),
        bookmark: "[]"
    };
}

// Start from the input that the first edge touches, and join the rest of the
// facts along the edges.
function joinEdges(queryDescription: QueryDescription, schema: string) {
    const firstEdge = queryDescription.edges[0];
    const predecessorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.predecessorFactIndex);
    const successorFact = queryDescription.inputs.find(i => i.factIndex === firstEdge.successorFactIndex);
    const firstFactIndex = predecessorFact ? predecessorFact.factIndex : successorFact!.factIndex;
    const writtenFactIndexes = new Set<number>().add(firstFactIndex);
    const givenFactIndexes = new Set<number>(queryDescription.inputs.map(input => input.factIndex));
    const joins = generateJoins(queryDescription.edges, writtenFactIndexes, schema, undefined, givenFactIndexes);
    return { firstFactIndex, joins, writtenFactIndexes };
}

// A specification with no matches has no edges. Each given is its own fact,
// selected by type and hash in the WHERE clause, so the givens are joined to
// one another without a condition.
//
// Two givens unified onto one unknown share a fact index: the fact carries an
// input for each, and must satisfy every one of their type-and-hash filters,
// which is how the read compares the givens to each other. One fact is one
// table reference, so join each distinct index once and skip the one already
// in the FROM clause. Every input keeps its own filter in the WHERE clause.
function joinGivens(queryDescription: QueryDescription, schema: string) {
    const [ first, ...rest ] = queryDescription.inputs;
    const writtenFactIndexes = new Set<number>().add(first.factIndex);
    const joins: string[] = [];
    rest.forEach(input => {
        if (writtenFactIndexes.has(input.factIndex)) {
            return;
        }
        writtenFactIndexes.add(input.factIndex);
        joins.push(` CROSS JOIN ${schema}.fact f${input.factIndex}`);
    });
    return { firstFactIndex: first.factIndex, joins, writtenFactIndexes };
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

function generateJoins(edges: EdgeDescription[], writtenFactIndexes: Set<number>, schema: string, exclusion: StagedExclusion | undefined, givenFactIndexes: Set<number>) {
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
                    ` ON f${edge.successorFactIndex}.fact_id = e${edge.edgeIndex}.successor_fact_id` +
                    excludeStaged(edge.successorFactIndex, exclusion)
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

function generateExistentialWhereClause(existentialCondition: ExistentialConditionDescription, outerFactIndexes: Set<number>, schema: string, staged: StagedExclusion | undefined, exclusion: StagedExclusion | undefined): string {
    const firstEdge = existentialCondition.edges[0];
    const writtenFactIndexes = new Set<number>(outerFactIndexes);
    const conditionGivenFactIndexes = new Set<number>(existentialCondition.inputs.map(input => input.factIndex));
    const firstJoin: string[] = [];
    const whereClause: string[] = [];
    // A given that first appears inside this condition is an input of the
    // condition rather than of the query, so the enclosing scope has not
    // written it. When the condition's FIRST edge walks from it, neither end
    // of that edge is written, exactly as for a later edge, so bring the given
    // in the same way and let the branches below correlate the edge against it.
    crossJoinUnreachedGiven(schema, firstEdge, writtenFactIndexes, conditionGivenFactIndexes, firstJoin);
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
                ` ON f${firstEdge.successorFactIndex}.fact_id = e${firstEdge.edgeIndex}.successor_fact_id` +
                excludeStaged(firstEdge.successorFactIndex, exclusion)
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
    const tailJoins: string[] = generateJoins(existentialCondition.edges.slice(1), writtenFactIndexes, schema, exclusion, conditionGivenFactIndexes);
    const joins = firstJoin.concat(tailJoins);
    const inputWhereClauses = existentialCondition.inputs
        .map(input => ` AND f${input.factIndex}.fact_type_id = $${input.factTypeParameter} AND f${input.factIndex}.hash = $${input.factHashParameter}`)
        .join("");
    const factEqualityWhereClauses = factEqualityClauses(existentialCondition.factEqualities);
    const existentialWhereClauses = existentialCondition.existentialConditions
        .map(e => ` AND ${e.exists ? "EXISTS" : "NOT EXISTS"} (${generateExistentialWhereClause(e, writtenFactIndexes, schema, staged, exclusionWithin(e.exists, exclusion, staged))})`)
        .join("");
    return `SELECT 1 FROM ${schema}.edge e${firstEdge.edgeIndex}${joins.join("")} WHERE ${whereClause.join(" AND ")}${inputWhereClauses}${factEqualityWhereClauses}${existentialWhereClauses}`;
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
    parentFactIds: number[];
    tuple: ReferencesByName;
    result: any;
}

interface ChildResults {
    parentFactIds: number[];
    results: ProjectedResult[];
}

export interface SpecificationLabel {
    name: string;
    index: number;
    type: string;
}

export interface SpecificationSqlQuery {
    sql: string;
    parameters: (string | number | number[])[];
    labels: SpecificationLabel[];
    bookmark: string;
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
    timestamp: Date;
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
        // The fact indexes of the labels of the composer one level up, in the
        // order that composer's own identifier lists them. A child query
        // extends its parent's, so every one of them is in the child's rows,
        // but not necessarily at the front: a child that reaches a given its
        // parent did not reach allocates a new input, which lands among the
        // inputs and not after them. Addressing the parent's labels by fact
        // index rather than by position is what lets such a child's rows be
        // grouped under the parent rows they belong to.
        private readonly parentFactIndexes: number[],
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
            parentFactIds: this.parentIdentifierOf(row),
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
        let parentFactIds: number[] = identifiedResults[0].parentFactIds;
        let results: ProjectedResult[] = [{
            tuple: identifiedResults[0].tuple,
            result: identifiedResults[0].result
        }];
        for (const identifiedResult of identifiedResults.slice(1)) {
            const nextParentFactIds = identifiedResult.parentFactIds;
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

    // The identifier the composer one level up computes for its own row, read
    // out of this row. A child row belongs under the parent row whose
    // identifier this equals.
    private parentIdentifierOf(row: ResultSetRow): number[] {
        return this.parentFactIndexes.map(factIndex => row[factIndex].factId);
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
                    .filter(label => !this.parentFactIndexes.includes(label.index))
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
        else if (this.resultProjection.type === "time") {
            return this.timeValue(this.resultProjection, row);
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
        else if (projection.type === "time") {
            return this.timeValue(projection, row);
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

    private timeValue(projection: TimeProjection, row: ResultSetRow): any {
        const label = this.getLabel(projection.label);
        return row[label.index].timestamp;
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
        private queryDescriptionBuilder: QueryDescriptionBuilder
    ) { }

    buildDescription(start: FactReference[], specification: Specification): ResultDescription {
        validateGiven(start, specification);

        const labels = specification.given.map(g => g.label);
        let queryDescription = QueryDescription.unsatisfiable;
        let knownFacts: FactByLabel = {};

        // A path condition in a match is what allocates a given as an input.
        // With no matches, nothing would, and the query would stay
        // unsatisfiable. Select every given by type and hash instead, so that
        // the conditions on the givens have facts to apply to.
        if (specification.matches.length === 0) {
            ({ queryDescription, knownFacts } = this.givensAsInputs(specification.given, start));
        }

        // First process main matches to build the result description
        const resultDescription = this.createResultDescription(queryDescription, specification.given, start, specification.matches, specification.projection, knownFacts, []);
        
        // Then process conditions from given if we have a satisfiable query
        if (resultDescription.queryDescription.isSatisfiable()) {
            queryDescription = resultDescription.queryDescription;
            knownFacts = resultDescription.queryDescription.outputs.reduce((acc, output) => ({
                ...acc,
                [output.label]: { factIndex: output.factIndex, type: output.type }
            }), {} as FactByLabel);
            
            // Also include inputs in knownFacts
            for (const input of resultDescription.queryDescription.inputs) {
                if (!knownFacts[input.label]) {
                    knownFacts[input.label] = { factIndex: input.factIndex, type: input.type };
                }
            }
            
            // Process conditions from each given
            for (const givenItem of specification.given) {
                if (givenItem.conditions && givenItem.conditions.length > 0) {
                    for (const condition of givenItem.conditions) {
                        const { query: queryDescriptionWithExistential, path: conditionalPath } = queryDescription.withExistentialCondition(condition.exists, []);
                        const { queryDescription: queryDescriptionConditional } = this.queryDescriptionBuilder.addEdges(queryDescriptionWithExistential, labels, start, knownFacts, conditionalPath, condition.matches);
                        
                        if (queryDescriptionConditional.isSatisfiable()) {
                            queryDescription = queryDescriptionConditional;
                        }
                        else if (condition.exists) {
                            // A condition that no fact in the store can
                            // satisfy is false when it is positive, so no
                            // tuple matches. When it is negative it is true,
                            // and is dropped.
                            return {
                                ...resultDescription,
                                queryDescription: QueryDescription.unsatisfiable
                            };
                        }
                    }
                }
            }
            
            // Return updated result description with conditions applied
            return {
                ...resultDescription,
                queryDescription
            };
        }
        
        return resultDescription;
    }

    private givensAsInputs(given: SpecificationGiven[], start: FactReference[]): { queryDescription: QueryDescription, knownFacts: FactByLabel } {
        let queryDescription = QueryDescription.unsatisfiable;
        let knownFacts: FactByLabel = {};
        for (const [index, givenItem] of given.entries()) {
            const factTypeId = this.queryDescriptionBuilder.factTypeId(start[index].type);
            if (!factTypeId) {
                // A given of a type the store has never seen is not a fact it
                // holds, so no tuple can match.
                return { queryDescription: QueryDescription.unsatisfiable, knownFacts: {} };
            }
            const { queryDescription: withInput, factDescription } = queryDescription.withInputParameter(
                givenItem.label,
                factTypeId,
                start[index].hash,
                []
            );
            queryDescription = withInput;
            knownFacts = { ...knownFacts, [givenItem.label.name]: factDescription };
        }
        return { queryDescription, knownFacts };
    }

    private createResultDescription(queryDescription: QueryDescription, given: SpecificationGiven[], start: FactReference[], matches: Match[], projection: Projection, knownFacts: FactByLabel, path: number[]): ResultDescription {
        const givenTuple = given.reduce((acc, givenItem, index) => ({
            ...acc,
            [givenItem.label.name]: start[index]
        }), {} as ReferencesByName);
        
        // Process main matches
        const labels = given.map(g => g.label);
        ({ queryDescription, knownFacts } = this.queryDescriptionBuilder.addEdges(queryDescription, labels, start, knownFacts, path, matches));
        
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
                .filter(projection => projection.type === "field" || projection.type === "hash" || projection.type === "fact" || projection.type === "time") as ({ name: string } & SingularProjection)[];
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

/**
 * @param stagedFactIds The ids of facts that exist only in the caller's
 * uncommitted transaction. Beneath a negative existential condition a
 * successor walk does not see them. Empty for `read`, which generates exactly
 * the SQL it always has.
 */
export function resultSqlFromSpecification(start: FactReference[], specification: Specification, factTypes: FactTypeMap, roleMap: RoleMap, schema: string, stagedFactIds: number[] = []): ResultComposer | null {
    const queryDescriptionBuilder = new QueryDescriptionBuilder(factTypes, roleMap);
    const descriptionBuilder = new ResultDescriptionBuilder(queryDescriptionBuilder);
    const description = descriptionBuilder.buildDescription(start, specification);

    if (!description.queryDescription.isSatisfiable()) {
        return null;
    }
    // The top level has no composer above it. Its givens stand in: each is
    // fixed by type and hash, so they take the same value in every row and
    // group them all together, as the given count did when every given was an
    // input of the top-level query.
    return createResultComposer(description, description.queryDescription.inputs.map(input => input.factIndex), schema, stagedFactIds);
}

function createResultComposer(description: ResultDescription, parentFactIndexes: number[], schema: string, stagedFactIds: number[]): ResultComposer {
    const sqlQuery = generateResultSqlQuery(description.queryDescription, schema, stagedFactIds);
    const resultProjection = description.resultProjection;
    // The fact indexes of this query's own labels, in the order
    // generateResultSqlQuery lists them, which is the order its identifier
    // uses. Each child groups its rows by these.
    const ownFactIndexes = labelFactIndexes(description.queryDescription);
    const childResultComposers = description.childResultDescriptions
        .filter(child => child.queryDescription.isSatisfiable())
        .map(child => ({
            name: child.name,
            resultComposer: createResultComposer(child, ownFactIndexes, schema, stagedFactIds)
        }));
    return new ResultComposer(sqlQuery, resultProjection, parentFactIndexes, description.givenTuple, childResultComposers);
}

function labelFactIndexes(queryDescription: QueryDescription): number[] {
    return [ ...queryDescription.inputs, ...queryDescription.outputs ]
        .map(label => label.factIndex);
}