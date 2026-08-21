/** Routing 错误。 */
export class RoutingError extends Error {
    code;
    routeId;
    /** Evidence captured at the exact rejection point for durable diagnostics. */
    evidence;
    constructor(code, message, routeId, evidence) {
        super(message);
        this.name = 'RoutingError';
        this.code = code;
        if (routeId !== undefined)
            this.routeId = routeId;
        if (evidence !== undefined)
            this.evidence = evidence;
    }
}
