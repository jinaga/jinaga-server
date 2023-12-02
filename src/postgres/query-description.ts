import { FactReference, Label, Match, PathCondition } from "jinaga";
import { FactTypeMap, RoleMap, ensureGetFactTypeId, getFactTypeId, getRoleId } from "./maps";

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

export interface ExistentialConditionDescription {
    exists: boolean;
    inputs: InputDescription[];
    edges: EdgeDescription[];
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
        public readonly existentialConditions: ExistentialConditionDescription[] = []
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

export type FactByLabel = {
    [label: string]: FactDescription;
};

export class QueryDescriptionBuider {
    constructor(
        private factTypes: FactTypeMap,
        private roleMap: RoleMap
    ) { }

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