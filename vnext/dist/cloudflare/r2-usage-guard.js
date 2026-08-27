"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.R2UsageGuard = exports.DEFAULT_R2_USAGE_LIMITS = void 0;
exports.getCurrentUtcMonthKey = getCurrentUtcMonthKey;
exports.DEFAULT_R2_USAGE_LIMITS = {
    maxTotalStoredBytes: 2 * 1024 * 1024 * 1024, // 2 GiB = 2147483648 bytes
    maxSingleArtifactBytes: 20 * 1024 * 1024, // 20 MiB = 20971520 bytes
    maxLiveObjectCount: 2000,
    maxClassAOperationsMonth: 100000,
    maxClassBOperationsMonth: 1000000,
    retentionDays: 7
};
function getCurrentUtcMonthKey(d = new Date()) {
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}
class R2UsageGuard {
    limits;
    state;
    storage;
    constructor(storage, limits = {}) {
        this.storage = storage;
        this.limits = {
            ...exports.DEFAULT_R2_USAGE_LIMITS,
            ...limits
        };
        this.state = {
            monthKey: getCurrentUtcMonthKey(),
            storedBytes: 0,
            objectCount: 0,
            classAOperations: 0,
            classBOperations: 0,
            updatedAt: Date.now()
        };
    }
    async hydrate() {
        if (!this.storage)
            return;
        try {
            const persisted = await this.storage.getR2UsageAccounting();
            if (persisted) {
                this.state = {
                    monthKey: persisted.monthKey || getCurrentUtcMonthKey(),
                    storedBytes: persisted.storedBytes || 0,
                    objectCount: persisted.objectCount || 0,
                    classAOperations: persisted.classAOperations || 0,
                    classBOperations: persisted.classBOperations || 0,
                    updatedAt: persisted.updatedAt || Date.now()
                };
            }
            this.ensureMonthCurrent();
        }
        catch (err) {
            console.error('[R2_GUARD] Failed to hydrate R2 accounting:', err);
        }
    }
    ensureMonthCurrent(now = new Date()) {
        const currentMonthKey = getCurrentUtcMonthKey(now);
        if (this.state.monthKey !== currentMonthKey) {
            this.state.monthKey = currentMonthKey;
            this.state.classAOperations = 0;
            this.state.classBOperations = 0;
            this.state.updatedAt = now.getTime();
            if (this.storage) {
                void this.storage.saveR2UsageAccounting(this.state);
            }
        }
    }
    getState() {
        this.ensureMonthCurrent();
        return { ...this.state };
    }
    getLimits() {
        return { ...this.limits };
    }
    async checkAndValidatePut(objectSizeBytes) {
        this.ensureMonthCurrent();
        if (objectSizeBytes > this.limits.maxSingleArtifactBytes) {
            throw new Error(`R2_USAGE_LIMIT_EXCEEDED: Artifact size (${objectSizeBytes} bytes) exceeds maximum single artifact limit (${this.limits.maxSingleArtifactBytes} bytes / 20 MiB)`);
        }
        if (this.state.storedBytes + objectSizeBytes > this.limits.maxTotalStoredBytes) {
            throw new Error(`R2_USAGE_LIMIT_EXCEEDED: Storing ${objectSizeBytes} bytes would exceed maximum total storage limit (${this.limits.maxTotalStoredBytes} bytes / 2 GiB). Current stored: ${this.state.storedBytes} bytes`);
        }
        if (this.state.objectCount + 1 > this.limits.maxLiveObjectCount) {
            throw new Error(`R2_USAGE_LIMIT_EXCEEDED: Storing object would exceed maximum live object count limit (${this.limits.maxLiveObjectCount}). Current count: ${this.state.objectCount}`);
        }
        if (this.state.classAOperations + 1 > this.limits.maxClassAOperationsMonth) {
            throw new Error(`R2_USAGE_LIMIT_EXCEEDED: Monthly Class A operations limit (${this.limits.maxClassAOperationsMonth}) exceeded. Current operations: ${this.state.classAOperations}`);
        }
    }
    async recordPutSuccess(objectSizeBytes) {
        this.ensureMonthCurrent();
        this.state.storedBytes += objectSizeBytes;
        this.state.objectCount += 1;
        this.state.classAOperations += 1;
        this.state.updatedAt = Date.now();
        if (this.storage) {
            await this.storage.saveR2UsageAccounting(this.state);
        }
    }
    async checkAndValidateGet() {
        this.ensureMonthCurrent();
        if (this.state.classBOperations + 1 > this.limits.maxClassBOperationsMonth) {
            throw new Error(`R2_USAGE_LIMIT_EXCEEDED: Monthly Class B operations limit (${this.limits.maxClassBOperationsMonth}) exceeded. Current operations: ${this.state.classBOperations}`);
        }
    }
    async recordGetSuccess() {
        this.ensureMonthCurrent();
        this.state.classBOperations += 1;
        this.state.updatedAt = Date.now();
        if (this.storage) {
            await this.storage.saveR2UsageAccounting(this.state);
        }
    }
    async checkAndValidateDelete() {
        this.ensureMonthCurrent();
        if (this.state.classAOperations + 1 > this.limits.maxClassAOperationsMonth) {
            throw new Error(`R2_USAGE_LIMIT_EXCEEDED: Monthly Class A operations limit (${this.limits.maxClassAOperationsMonth}) exceeded. Current operations: ${this.state.classAOperations}`);
        }
    }
    async recordDeleteSuccess(objectSizeBytes) {
        this.ensureMonthCurrent();
        if (objectSizeBytes && objectSizeBytes > 0) {
            this.state.storedBytes = Math.max(0, this.state.storedBytes - objectSizeBytes);
        }
        this.state.objectCount = Math.max(0, this.state.objectCount - 1);
        this.state.classAOperations += 1;
        this.state.updatedAt = Date.now();
        if (this.storage) {
            await this.storage.saveR2UsageAccounting(this.state);
        }
    }
}
exports.R2UsageGuard = R2UsageGuard;
