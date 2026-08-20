/** Routing 错误。 */
export class RoutingError extends Error {
    code;
    routeId;
    constructor(code, message, routeId) {
        super(message);
        this.name = 'RoutingError';
        this.code = code;
        if (routeId !== undefined)
            this.routeId = routeId;
    }
}
