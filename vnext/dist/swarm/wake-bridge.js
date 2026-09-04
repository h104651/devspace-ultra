"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WakeBridge = void 0;
const events_1 = require("events");
const crypto = __importStar(require("crypto"));
class WakeBridge {
    emitter = new events_1.EventEmitter();
    eventHistory = [];
    maxHistory;
    constructor(maxHistory = 100) {
        this.maxHistory = maxHistory;
    }
    emitWake(channel, targetWorkerId, action = 'WAKE', payload) {
        const event = {
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
    onChannel(channel, listener) {
        this.emitter.on(channel, listener);
    }
    offChannel(channel, listener) {
        this.emitter.off(channel, listener);
    }
    getRecentEvents(limit = 20) {
        return this.eventHistory.slice(-limit).reverse();
    }
}
exports.WakeBridge = WakeBridge;
