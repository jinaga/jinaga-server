import { FactReference, Label, Match, PathCondition } from "jinaga";
import { FactTypeMap, RoleMap, getFactTypeId, getRoleId } from "./maps";

export interface FactDescription {
    type: string;
    factIndex: number;
}

export interface EdgeDescription {
    edgeIndex: number;
    predecessorFactIndex: number;
    successorFactIndex: number;
    roleParameter: number;
}

/**
 * An identity between two labels that are both already bound to facts.
 *
 * A path condition with roles ties its two sides together with an edge. One
 * with no roles has no edge to carry the tie, so when both of its labels are
 * already bound the condition is an equality between two facts, compared in
 * the scope where the condition appears.
 */
export interface FactEqualityDescription {
    leftFactIndex: number;
    rightFactIndex: number;
}

export interface ExistentialConditionDescription {
    exists: boolean;
    inputs: InputDescription[];
    edges: EdgeDescription[];
    factEqualities: FactEqualityDescription[];
    existentialConditions: ExistentialConditionDescription[];
}

export interface InputDescription {
    label: string;
    type: string;
    factIndex: number;
    factTypeParameter: number;
    factHashParameter: number;
}

export interface OutputDescription {
    label: string;
    type: string;
    factIndex: number;
}

function countEdges(existentialConditions: ExistentialConditionDescription[]): number {
    return existentialConditions.reduce((count, c) => count + c.edges.length + countEdges(c.existentialConditions),
        0);
}

export class QueryDescription {
    // An unsatisfiable query description will produce no results.
    static unsatisfiable: QueryDescription = new QueryDescription(
        [], [], [], [], [], []
    );

    constructor(
        public readonly inputs: InputDescription[],
        public readonly parameters: (string | number)[],
        public readonly outputs: OutputDescription[],
        public readonly facts: FactDescription[],
        public readonly edges: EdgeDescription[],
        public readonly existentialConditions: ExistentialConditionDescription[] = [],
        public readonly factEqualities: FactEqualityDescription[] = []
    ) {}

    public withParameter(parameter: string | number): { query: QueryDescription; parameterIndex: number; } {
        const parameterIndex = this.parameters.length + 1;
        const query = new QueryDescription(
            this.inputs,
            this.parameters.concat(parameter),
            this.outputs,
            this.facts,
            this.edges,
            this.existentialConditions,
            this.factEqualities
        );
        return { query, parameterIndex };
    }

    public withInputParameter(label: Label, factTypeId: number, factHash: string, path: number[]): { queryDescription: QueryDescription; factDescription: FactDescription; } {
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
        ];
        const input: InputDescription = {
            label: label.name,
            type: label.type,
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
                this.existentialConditions,
                this.factEqualities
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
                existentialConditions,
                this.factEqualities
            );
            return { queryDescription, factDescription };
        }
    }

    public withInputOnExistingFact(label: Label, factTypeId: number, factHash: string, factIndex: number, path: number[]): QueryDescription {
        const factTypeParameter = this.parameters.length + 1;
        const factHashParameter = factTypeParameter + 1;
        const input: InputDescription = {
            label: label.name,
            type: label.type,
            factIndex,
            factTypeParameter,
            factHashParameter
        };
        const parameters = this.parameters.concat(factTypeId, factHash);
        if (path.length === 0) {
            return new QueryDescription(
                [...this.inputs, input],
                parameters,
                this.outputs,
                this.facts,
                this.edges,
                this.existentialConditions,
                this.factEqualities
            );
        }
        else {
            const existentialConditions = existentialsWithInput(this.existentialConditions, input, path);
            return new QueryDescription(
                this.inputs,
                parameters,
                this.outputs,
                this.facts,
                this.edges,
                existentialConditions,
                this.factEqualities
            );
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
            this.existentialConditions,
            this.factEqualities
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
            this.existentialConditions,
            this.factEqualities
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
                this.existentialConditions,
                this.factEqualities
            )
            : new QueryDescription(
                this.inputs,
                this.parameters,
                this.outputs,
                this.facts,
                this.edges,
                existentialsWithEdge(this.existentialConditions, edge, path),
                this.factEqualities
            );
        return query;
    }

    public withFactEquality(leftFactIndex: number, rightFactIndex: number, path: number[]): QueryDescription {
        const factEquality: FactEqualityDescription = {
            leftFactIndex,
            rightFactIndex
        };
        const query = (path.length === 0)
            ? new QueryDescription(
                this.inputs,
                this.parameters,
                this.outputs,
                this.facts,
                this.edges,
                this.existentialConditions,
                this.factEqualities.concat(factEquality)
            )
            : new QueryDescription(
                this.inputs,
                this.parameters,
                this.outputs,
                this.facts,
                this.edges,
                existentialsWithFactEquality(this.existentialConditions, factEquality, path),
                this.factEqualities
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
            newExistentialConditions,
            this.factEqualities
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
        return this.inputs.length + this.outputs.length;
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

function existentialsWithFactEquality(existentialConditions: ExistentialConditionDescription[], factEquality: FactEqualityDescription, path: number[]): ExistentialConditionDescription[] {
    if (path.length === 1) {
        return existentialConditions.map((c, i) => i === path[0] ?
            {
                ...c,
                factEqualities: [...c.factEqualities, factEquality]
            } :
            c
        );
    }
    else {
        return existentialConditions.map((c, i) => i === path[0] ?
            {
                ...c,
                existentialConditions: existentialsWithFactEquality(c.existentialConditions, factEquality, path.slice(1))
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
                factEqualities: [],
                existentialConditions: []
            }
        ];
        return { existentialConditions: existentialConditions, path };
    }
    else {
        const { existentialConditions: newExistentialConditions, path: newPath } = existentialsWithNewCondition(existentialConditions[path[0]].existentialConditions, exists, path.slice(1));
        existentialConditions = existentialConditions.map((c, i) => i === path[0] ?
            {
                ...c,
                existentialConditions: newExistentialConditions
            } :
            c
        );
        path = [path[0], ...newPath];
        return { existentialConditions: existentialConditions, path };
    }
}

export type FactByLabel = {
    [label: string]: FactDescription;
};

export class QueryDescriptionBuilder {
    constructor(
        private factTypes: FactTypeMap,
        private roleMap: RoleMap
    ) { }

    public factTypeId(type: string): number | undefined {
        return getFactTypeId(this.factTypes, type);
    }

    public addEdges(queryDescription: QueryDescription, given: Label[], start: FactReference[], knownFacts: FactByLabel, path: number[], matches: Match[]): { queryDescription: QueryDescription, knownFacts: FactByLabel } {
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
            const factTypeId = getFactTypeId(this.factTypes, start[givenIndex].type);
            if (!factTypeId) {
                return { queryDescription: QueryDescription.unsatisfiable, knownFacts };
            }
            // When this is an identity path condition (no roles on either side)
            // and the unknown has already been allocated, unify the given with
            // the existing fact: register the type+hash filter on the existing
            // factIndex rather than allocating a disconnected fact node.
            const existingUnknown = knownFacts[unknown.name];
            const isIdentity = condition.rolesLeft.length === 0 && condition.rolesRight.length === 0;
            if (isIdentity && existingUnknown) {
                queryDescription = queryDescription.withInputOnExistingFact(
                    given[givenIndex],
                    factTypeId,
                    start[givenIndex].hash,
                    existingUnknown.factIndex,
                    path
                );
                knownFacts = {
                    ...knownFacts,
                    [condition.labelRight]: existingUnknown
                };
            }
            else {
                const { queryDescription: newQueryDescription, factDescription } = queryDescription.withInputParameter(
                    given[givenIndex],
                    factTypeId,
                    start[givenIndex].hash,
                    path
                );
                queryDescription = newQueryDescription;
                knownFacts = {
                    ...knownFacts,
                    [condition.labelRight]: factDescription
                };
            }
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

        // An identity condition carries no roles, so neither walk above emitted
        // an edge to tie its two sides together. When both labels are already
        // bound, the condition is an equality between two facts: record it so
        // that this scope's WHERE clause compares them. Bound to the same fact
        // index, the condition holds trivially and needs no clause.
        if (knownFact && roleCount === 0 && knownFact.factIndex !== factIndex) {
            queryDescription = queryDescription.withFactEquality(knownFact.factIndex, factIndex, path);
        }

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