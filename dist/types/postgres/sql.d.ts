import { FactReference, Step } from 'jinaga';
export declare type SqlQuery = {
    sql: string;
    parameters: any[];
    pathLength: number;
};
export declare function sqlFromSteps(start: FactReference, steps: Step[]): SqlQuery;
