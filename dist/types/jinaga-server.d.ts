import { Handler, Request } from 'express';
import { AuthorizationRules, Jinaga } from 'jinaga';
export declare type JinagaServerConfig = {
    pgStore?: string;
    pgKeystore?: string;
    httpEndpoint?: string;
    authorization?: (a: AuthorizationRules) => AuthorizationRules;
    httpTimeoutSeconds?: number;
};
export declare type JinagaServerInstance = {
    handler: Handler;
    j: Jinaga;
    withSession: (req: Request, callback: ((j: Jinaga) => Promise<void>)) => Promise<void>;
};
export declare class JinagaServer {
    static create(config: JinagaServerConfig): JinagaServerInstance;
}
