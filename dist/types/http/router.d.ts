import { Handler } from 'express';
import { Authorization } from 'jinaga';
import { ProfileMessage } from 'jinaga';
export interface RequestUser {
    provider: string;
    id: string;
    profile: ProfileMessage;
}
export declare class HttpRouter {
    private authorization;
    handler: Handler;
    constructor(authorization: Authorization);
    private login;
    private query;
    private load;
    private save;
}
