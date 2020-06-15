export declare function flattenAsync<T, U>(collection: T[], selector: (element: T) => Promise<U[]>): Promise<U[]>;
export declare function flatten<T, U>(collection: T[], selector: (element: T) => U[]): U[];
export declare function mapAsync<T, U>(collection: T[], action: (element: T) => Promise<U>): Promise<U[]>;
export declare function filterAsync<T>(collection: T[], predicate: (element: T) => Promise<boolean>): Promise<T[]>;
export declare function findIndex<T>(array: T[], predicate: ((element: T) => boolean)): number;
export declare function distinct<T>(value: T, index: number, self: T[]): boolean;
