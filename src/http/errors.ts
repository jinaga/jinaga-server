/**
 * A request whose body exceeded a limit this server imposes, independently of
 * whether the body is well formed. `handleError` in `router.ts` maps it to
 * `413 Payload Too Large` and sends `message` as the body, so a message names
 * the limit that was passed rather than describing the content.
 *
 * This lives apart from the route that first needed it because the save and
 * read paths bound different things and both answer with the same status.
 */
export class PayloadTooLarge extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PayloadTooLarge";
        // Restore the prototype chain so `instanceof` survives the ES5 target
        // that `tsc` compiles Error subclasses down to.
        Object.setPrototypeOf(this, PayloadTooLarge.prototype);
    }
}
