import { GatewayDurableObject, Env } from './gateway-durable-object';

export { GatewayDurableObject };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route all traffic to a singleton Gateway Durable Object instance
    const id = env.GATEWAY_DO.idFromName('global-gateway-singleton');
    const stub = env.GATEWAY_DO.get(id);
    return stub.fetch(request);
  }
};
