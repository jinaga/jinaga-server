import { FactRecord } from 'jinaga';
export declare type EdgeRecord = {
    predecessor_hash: string;
    predecessor_type: string;
    successor_hash: string;
    successor_type: string;
    role: string;
};
export declare function makeEdgeRecords(fact: FactRecord): EdgeRecord[];
