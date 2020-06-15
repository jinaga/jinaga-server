import { HttpConnection, HttpResponse } from "jinaga";
export declare class NodeHttpConnection implements HttpConnection {
    private url;
    constructor(url: string);
    get(path: string): Promise<{}>;
    post(tail: string, body: {}, timeoutSeconds: number): Promise<HttpResponse>;
}
