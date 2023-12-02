import { Label } from "jinaga";
import { existentialsWithInput, existentialsWithEdge, existentialsWithNewCondition } from "./specification-result-sql";

interface SpecificationLabel {
    name: string;
    index: number;
    type: string;
}

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

export interface SpecificationSqlQuery {
    sql: string;
    parameters: (string | number | number[])[];
    labels: SpecificationLabel[];
    bookmark: string;
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

export function countEdges(existentialConditions: ExistentialConditionDescription[]): number {
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