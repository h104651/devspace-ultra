export interface R2UsageLimits {
  maxTotalStoredBytes: number;
  maxSingleArtifactBytes: number;
  maxLiveObjectCount: number;
  maxClassAOperationsMonth: number;
  maxClassBOperationsMonth: number;
  retentionDays: number;
}

export const HARD_IMMUTABLE_LIMITS: R2UsageLimits = {
  maxTotalStoredBytes: 2 * 1024 * 1024 * 1024, // 2147483648 bytes (2 GiB)
  maxSingleArtifactBytes: 20 * 1024 * 1024,    // 20971520 bytes (20 MiB)
  maxLiveObjectCount: 2000,
  maxClassAOperationsMonth: 100000,
  maxClassBOperationsMonth: 1000000,
  retentionDays: 7
};

export const DEFAULT_R2_USAGE_LIMITS: R2UsageLimits = { ...HARD_IMMUTABLE_LIMITS };

export interface R2UsageRecord {
  monthKey: string; // "YYYY-MM" (UTC)
  storedBytes: number;
  objectCount: number;
  classAOperations: number;
  classBOperations: number;
  updatedAt?: number;
}

export interface IR2UsageStorage {
  getR2UsageAccounting(): Promise<R2UsageRecord | undefined>;
  saveR2UsageAccounting(record: R2UsageRecord): Promise<void>;
}

export function getCurrentUtcMonthKey(d: Date = new Date()): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function parseSafeLimit(configuredValue: any, hardCeiling: number): number {
  if (configuredValue === undefined || configuredValue === null || configuredValue === '') {
    return hardCeiling;
  }
  const parsed = typeof configuredValue === 'number' ? configuredValue : Number(configuredValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || isNaN(parsed)) {
    return hardCeiling;
  }
  return Math.min(Math.floor(parsed), hardCeiling);
}

export function buildEffectiveLimits(configured: Partial<Record<keyof R2UsageLimits, any>> = {}): R2UsageLimits {
  return {
    maxTotalStoredBytes: parseSafeLimit(configured.maxTotalStoredBytes, HARD_IMMUTABLE_LIMITS.maxTotalStoredBytes),
    maxSingleArtifactBytes: parseSafeLimit(configured.maxSingleArtifactBytes, HARD_IMMUTABLE_LIMITS.maxSingleArtifactBytes),
    maxLiveObjectCount: parseSafeLimit(configured.maxLiveObjectCount, HARD_IMMUTABLE_LIMITS.maxLiveObjectCount),
    maxClassAOperationsMonth: parseSafeLimit(configured.maxClassAOperationsMonth, HARD_IMMUTABLE_LIMITS.maxClassAOperationsMonth),
    maxClassBOperationsMonth: parseSafeLimit(configured.maxClassBOperationsMonth, HARD_IMMUTABLE_LIMITS.maxClassBOperationsMonth),
    retentionDays: parseSafeLimit(configured.retentionDays, HARD_IMMUTABLE_LIMITS.retentionDays),
  };
}

export class R2UsageGuard {
  private limits: R2UsageLimits;
  private state: R2UsageRecord;
  private storage?: IR2UsageStorage;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(storage?: IR2UsageStorage, configuredLimits: Partial<Record<keyof R2UsageLimits, any>> = {}) {
    this.storage = storage;
    this.limits = buildEffectiveLimits(configuredLimits);
    this.state = {
      monthKey: getCurrentUtcMonthKey(),
      storedBytes: 0,
      objectCount: 0,
      classAOperations: 0,
      classBOperations: 0,
      updatedAt: Date.now()
    };
  }

  private async runWithLock<T>(action: () => Promise<T>): Promise<T> {
    let release: () => void;
    const nextLock = new Promise<void>(resolve => {
      release = resolve;
    });
    const prevLock = this.lockPromise;
    this.lockPromise = nextLock;

    await prevLock;
    try {
      return await action();
    } finally {
      release!();
    }
  }

  public async hydrate(): Promise<void> {
    if (!this.storage) return;
    return this.runWithLock(async () => {
      try {
        const persisted = await this.storage!.getR2UsageAccounting();
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
      } catch (err) {
        console.error('[R2_GUARD] Failed to hydrate R2 accounting:', err);
      }
    });
  }

  public ensureMonthCurrent(now: Date = new Date()): void {
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

  public getState(): Readonly<R2UsageRecord> {
    this.ensureMonthCurrent();
    return { ...this.state };
  }

  public getLimits(): Readonly<R2UsageLimits> {
    return { ...this.limits };
  }

  /**
   * Durably reserves quota for a PUT operation BEFORE R2.put is called.
   * Fails closed if quota is exceeded or storage persistence fails.
   */
  public async reservePut(objectSizeBytes: number): Promise<void> {
    return this.runWithLock(async () => {
      this.ensureMonthCurrent();

      if (objectSizeBytes > this.limits.maxSingleArtifactBytes) {
        throw new Error(
          `R2_USAGE_LIMIT_EXCEEDED: Artifact size (${objectSizeBytes} bytes) exceeds maximum single artifact limit (${this.limits.maxSingleArtifactBytes} bytes / 20 MiB)`
        );
      }

      if (this.state.storedBytes + objectSizeBytes > this.limits.maxTotalStoredBytes) {
        throw new Error(
          `R2_USAGE_LIMIT_EXCEEDED: Storing ${objectSizeBytes} bytes would exceed maximum total storage limit (${this.limits.maxTotalStoredBytes} bytes / 2 GiB). Current stored: ${this.state.storedBytes} bytes`
        );
      }

      if (this.state.objectCount + 1 > this.limits.maxLiveObjectCount) {
        throw new Error(
          `R2_USAGE_LIMIT_EXCEEDED: Storing object would exceed maximum live object count limit (${this.limits.maxLiveObjectCount}). Current count: ${this.state.objectCount}`
        );
      }

      if (this.state.classAOperations + 1 > this.limits.maxClassAOperationsMonth) {
        throw new Error(
          `R2_USAGE_LIMIT_EXCEEDED: Monthly Class A operations limit (${this.limits.maxClassAOperationsMonth}) exceeded. Current operations: ${this.state.classAOperations}`
        );
      }

      // Durably reserve BEFORE R2 network operation
      this.state.storedBytes += objectSizeBytes;
      this.state.objectCount += 1;
      this.state.classAOperations += 1;
      this.state.updatedAt = Date.now();

      if (this.storage) {
        await this.storage.saveR2UsageAccounting(this.state);
      }
    });
  }

  /**
   * Durably reserves quota for a GET operation BEFORE R2.get is called.
   * Fails closed if Class B monthly limit is exceeded or storage persistence fails.
   */
  public async reserveGet(): Promise<void> {
    return this.runWithLock(async () => {
      this.ensureMonthCurrent();

      if (this.state.classBOperations + 1 > this.limits.maxClassBOperationsMonth) {
        throw new Error(
          `R2_USAGE_LIMIT_EXCEEDED: Monthly Class B operations limit (${this.limits.maxClassBOperationsMonth}) exceeded. Current operations: ${this.state.classBOperations}`
        );
      }

      this.state.classBOperations += 1;
      this.state.updatedAt = Date.now();

      if (this.storage) {
        await this.storage.saveR2UsageAccounting(this.state);
      }
    });
  }

  /**
   * Durably reserves quota for a DELETE operation BEFORE R2.delete is called.
   */
  public async reserveDelete(): Promise<void> {
    return this.runWithLock(async () => {
      this.ensureMonthCurrent();

      if (this.state.classAOperations + 1 > this.limits.maxClassAOperationsMonth) {
        throw new Error(
          `R2_USAGE_LIMIT_EXCEEDED: Monthly Class A operations limit (${this.limits.maxClassAOperationsMonth}) exceeded. Current operations: ${this.state.classAOperations}`
        );
      }

      this.state.classAOperations += 1;
      this.state.updatedAt = Date.now();

      if (this.storage) {
        await this.storage.saveR2UsageAccounting(this.state);
      }
    });
  }

  /**
   * Confirms successful delete and reduces storedBytes and objectCount.
   */
  public async confirmDelete(deletedSizeBytes?: number): Promise<void> {
    return this.runWithLock(async () => {
      this.ensureMonthCurrent();
      if (deletedSizeBytes && deletedSizeBytes > 0) {
        this.state.storedBytes = Math.max(0, this.state.storedBytes - deletedSizeBytes);
      }
      this.state.objectCount = Math.max(0, this.state.objectCount - 1);
      this.state.updatedAt = Date.now();
      if (this.storage) {
        await this.storage.saveR2UsageAccounting(this.state);
      }
    });
  }

  // Backwards compatibility methods
  public async checkAndValidatePut(objectSizeBytes: number): Promise<void> {
    return this.reservePut(objectSizeBytes);
  }
  public async recordPutSuccess(_objectSizeBytes: number): Promise<void> {
    // No-op in reservation-first model (already reserved before PUT)
  }
  public async checkAndValidateGet(): Promise<void> {
    return this.reserveGet();
  }
  public async recordGetSuccess(): Promise<void> {
    // No-op in reservation-first model
  }
  public async checkAndValidateDelete(): Promise<void> {
    return this.reserveDelete();
  }
  public async recordDeleteSuccess(objectSizeBytes?: number): Promise<void> {
    return this.confirmDelete(objectSizeBytes);
  }
}
