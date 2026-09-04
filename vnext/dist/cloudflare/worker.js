"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayDurableObject = void 0;
const gateway_durable_object_1 = require("./gateway-durable-object");
Object.defineProperty(exports, "GatewayDurableObject", { enumerable: true, get: function () { return gateway_durable_object_1.GatewayDurableObject; } });
exports.default = {
    async fetch(request, env) {
        // Route all traffic to a singleton Gateway Durable Object instance
        const id = env.GATEWAY_DO.idFromName('global-gateway-singleton');
        const stub = env.GATEWAY_DO.get(id);
        return stub.fetch(request);
    }
};
