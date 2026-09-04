import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { WakeBridgeEvent } from '../types/swarm';

export class WakeBridge {
  private emitter: EventEmitter = new EventEmitter();
  private eventHistory: WakeBridgeEvent[] = [];
  private maxHistory: number;

  constructor(maxHistory = 100) {
    this.maxHistory = maxHistory;
  }

  public emitWake(channel: string, targetWorkerId?: string, action: WakeBridgeEvent['action'] = 'WAKE', payload?: any): WakeBridgeEvent {
    const event: WakeBridgeEvent = {
      eventId: crypto.randomUUID(),
      timestamp: Date.now(),
      channel,
      targetWorkerId,
      action,
      payload
    };

    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistory) {
      this.eventHistory.shift();
    }

    this.emitter.emit(channel, event);
    this.emitter.emit('*', event);
    return event;
  }

  public onChannel(channel: string, listener: (event: WakeBridgeEvent) => void): void {
    this.emitter.on(channel, listener);
  }

  public offChannel(channel: string, listener: (event: WakeBridgeEvent) => void): void {
    this.emitter.off(channel, listener);
  }

  public getRecentEvents(limit = 20): WakeBridgeEvent[] {
    return this.eventHistory.slice(-limit).reverse();
  }
}
