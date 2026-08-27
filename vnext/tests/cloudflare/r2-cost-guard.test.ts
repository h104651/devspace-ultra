import * as assert from 'assert';
import {
  R2UsageGuard,
  IR2UsageStorage,
  R2UsageRecord,
  HARD_IMMUTABLE_LIMITS,
  buildEffectiveLimits,
  parseSafeLimit
} from '../../src/cloudflare/r2-usage-guard';
import { CloudflareR2ArtifactStorage, R2Bucket } from '../../src/cloudflare/r2-artifact-storage';

class MockStorage implements IR2UsageStorage {
  public saved?: R2UsageRecord;
  public failNextSave = false;

  async getR2UsageAccounting(): Promise<R2UsageRecord | undefined> {
    return this.saved ? structuredClone(this.saved) : undefined;
  }
  async saveR2UsageAccounting(record: R2UsageRecord): Promise<void> {
    if (this.failNextSave) {
      throw new Error('STORAGE_DISK_FULL: Failed to persist durable accounting');
    }
    this.saved = structuredClone(record);
  }
}

class TrackingMockR2Bucket implements R2Bucket {
  public objects: Map<string, Uint8Array> = new Map();
  public putCallCount = 0;
  public getCallCount = 0;
  public deleteCallCount = 0;
  public failNextGet = false;
  public failNextPut = false;

  async put(key: string, value: any): Promise<any> {
    this.putCallCount++;
    if (this.failNextPut) {
      throw new Error('R2_NETWORK_TIMEOUT: Put failed on remote');
    }
    const buf = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
    this.objects.set(key, buf);
    return { key, size: buf.byteLength };
  }

  async get(key: string): Promise<any> {
    this.getCallCount++;
    if (this.failNextGet) {
      throw new Error('R2_NETWORK_TIMEOUT: Get failed on remote');
    }
    const data = this.objects.get(key);
    if (!data) return null;
    return { arrayBuffer: async () => data.buffer };
  }

  async delete(key: string): Promise<void> {
    this.deleteCallCount++;
    this.objects.delete(key);
  }
}

export async function runR2CostGuardTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  console.log('--- Running R2 Hard Cost Guard & Usage Safety Tests ---');

  // Test 1: 20 MiB artifact accepted when quota remains
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const guard = new R2UsageGuard(new MockStorage());
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    const maxSingleBytes = 20 * 1024 * 1024; // 20 MiB
    await guard.reservePut(maxSingleBytes);
    assert.strictEqual(guard.getState().storedBytes, maxSingleBytes);
    assert.strictEqual(guard.getState().objectCount, 1);
    assert.strictEqual(guard.getState().classAOperations, 1);
    passed++;
  } catch (err) {
    console.error('Test 1 failed:', err);
    failed++;
  }

  // Test 2: >20 MiB artifact rejected BEFORE R2.put
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const guard = new R2UsageGuard(new MockStorage());
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    const overSizeBytes = 20 * 1024 * 1024 + 1; // 20 MiB + 1 byte
    let threw = false;
    try {
      await r2Storage.saveArtifactPayload(
        { id: 'art-over', taskId: 'task-1', name: 'large.bin', type: 'binary', sizeBytes: overSizeBytes, sha256: 'mock-sha256', createdAt: Date.now() },
        new Uint8Array(overSizeBytes)
      );
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('R2_USAGE_LIMIT_EXCEEDED'));
      assert.ok(err.message.includes('exceeds maximum single artifact limit'));
    }
    assert.strictEqual(threw, true, 'Must reject >20 MiB artifact');
    assert.strictEqual(mockR2.putCallCount, 0, 'ZERO R2 network operations must be performed on rejection');
    passed++;
  } catch (err) {
    console.error('Test 2 failed:', err);
    failed++;
  }

  // Test 3: 2 GiB total cap cannot be exceeded
  try {
    const mockStorage = new MockStorage();
    mockStorage.saved = {
      monthKey: '2026-08',
      storedBytes: 2 * 1024 * 1024 * 1024 - 100, // Only 100 bytes left
      objectCount: 10,
      classAOperations: 10,
      classBOperations: 5
    };
    const guard = new R2UsageGuard(mockStorage);
    await guard.hydrate();

    let threw = false;
    try {
      await guard.reservePut(200); // 200 bytes exceeds remaining 100 bytes
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('R2_USAGE_LIMIT_EXCEEDED'));
      assert.ok(err.message.includes('exceed maximum total storage limit'));
    }
    assert.strictEqual(threw, true, 'Must enforce 2 GiB total storage cap');
    passed++;
  } catch (err) {
    console.error('Test 3 failed:', err);
    failed++;
  }

  // Test 4: 2000 object limit cannot be exceeded
  try {
    const mockStorage = new MockStorage();
    mockStorage.saved = {
      monthKey: '2026-08',
      storedBytes: 1024,
      objectCount: 2000, // Reached limit
      classAOperations: 2000,
      classBOperations: 50
    };
    const guard = new R2UsageGuard(mockStorage);
    await guard.hydrate();

    let threw = false;
    try {
      await guard.reservePut(100);
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('R2_USAGE_LIMIT_EXCEEDED'));
      assert.ok(err.message.includes('maximum live object count limit'));
    }
    assert.strictEqual(threw, true, 'Must enforce 2000 object count cap');
    passed++;
  } catch (err) {
    console.error('Test 4 failed:', err);
    failed++;
  }

  // Test 5: 100,000 monthly Class A cap cannot be exceeded
  try {
    const mockStorage = new MockStorage();
    mockStorage.saved = {
      monthKey: '2026-08',
      storedBytes: 1024,
      objectCount: 50,
      classAOperations: 100000, // Limit reached
      classBOperations: 50
    };
    const guard = new R2UsageGuard(mockStorage);
    await guard.hydrate();

    let threw = false;
    try {
      await guard.reservePut(100);
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('R2_USAGE_LIMIT_EXCEEDED'));
      assert.ok(err.message.includes('Monthly Class A operations limit'));
    }
    assert.strictEqual(threw, true, 'Must enforce Class A operations limit');
    passed++;
  } catch (err) {
    console.error('Test 5 failed:', err);
    failed++;
  }

  // Test 6: 1,000,000 monthly Class B cap cannot be exceeded
  try {
    const mockStorage = new MockStorage();
    mockStorage.saved = {
      monthKey: '2026-08',
      storedBytes: 1024,
      objectCount: 50,
      classAOperations: 100,
      classBOperations: 1000000 // Limit reached
    };
    const guard = new R2UsageGuard(mockStorage);
    await guard.hydrate();

    let threw = false;
    try {
      await guard.reserveGet();
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('R2_USAGE_LIMIT_EXCEEDED'));
      assert.ok(err.message.includes('Monthly Class B operations limit'));
    }
    assert.strictEqual(threw, true, 'Must enforce Class B operations limit');
    passed++;
  } catch (err) {
    console.error('Test 6 failed:', err);
    failed++;
  }

  // Test 7: Counters survive hydration / restart
  try {
    const mockStorage = new MockStorage();
    const guard1 = new R2UsageGuard(mockStorage);
    await guard1.reservePut(500000);
    await guard1.reserveGet();

    const guard2 = new R2UsageGuard(mockStorage);
    await guard2.hydrate();
    assert.strictEqual(guard2.getState().storedBytes, 500000);
    assert.strictEqual(guard2.getState().objectCount, 1);
    assert.strictEqual(guard2.getState().classAOperations, 1);
    assert.strictEqual(guard2.getState().classBOperations, 1);
    passed++;
  } catch (err) {
    console.error('Test 7 failed:', err);
    failed++;
  }

  // Test 8 & 9: Month rollover resets A/B operations but DOES NOT reset storedBytes/objectCount
  try {
    const mockStorage = new MockStorage();
    mockStorage.saved = {
      monthKey: '2026-07', // Previous month
      storedBytes: 1048576, // 1 MiB
      objectCount: 42,
      classAOperations: 5000,
      classBOperations: 8000
    };
    const guard = new R2UsageGuard(mockStorage);
    await guard.hydrate();

    guard.ensureMonthCurrent(new Date('2026-08-15T12:00:00Z'));
    const state = guard.getState();
    assert.strictEqual(state.monthKey, '2026-08');
    assert.strictEqual(state.classAOperations, 0, 'Class A ops must reset on month rollover');
    assert.strictEqual(state.classBOperations, 0, 'Class B ops must reset on month rollover');
    assert.strictEqual(state.storedBytes, 1048576, 'storedBytes must NOT reset on month rollover');
    assert.strictEqual(state.objectCount, 42, 'objectCount must NOT reset on month rollover');
    passed++;
  } catch (err) {
    console.error('Test 8/9 failed:', err);
    failed++;
  }

  // Test 10 & 11: Quota failure produces R2_USAGE_LIMIT_EXCEEDED and performs ZERO network calls
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const mockStorage = new MockStorage();
    mockStorage.saved = {
      monthKey: '2026-08',
      storedBytes: 2147483648, // 2 GiB exactly (full)
      objectCount: 100,
      classAOperations: 100,
      classBOperations: 10
    };
    const guard = new R2UsageGuard(mockStorage);
    await guard.hydrate();
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    let threw = false;
    try {
      await r2Storage.saveArtifactPayload(
        { id: 'art-full', taskId: 'task-1', name: 'data.bin', type: 'binary', sizeBytes: 500000, sha256: 'mock-sha256', createdAt: Date.now() },
        new Uint8Array(500000)
      );
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('R2_USAGE_LIMIT_EXCEEDED'));
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(mockR2.putCallCount, 0, 'ZERO R2 put calls when full');
    passed++;
  } catch (err) {
    console.error('Test 10/11 failed:', err);
    failed++;
  }

  // Test 12: Normal >=256 KiB artifact still goes to R2
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const guard = new R2UsageGuard(new MockStorage());
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    const size = 300 * 1024; // 300 KiB >= 256 KiB threshold
    const payload = new Uint8Array(size);
    payload.fill(65);
    const art = await r2Storage.saveArtifact('task-test', 'large.json', payload, 'json');
    assert.ok(art.r2Key, '>=256 KiB artifact must be stored in R2');
    assert.strictEqual(mockR2.putCallCount, 1);
    assert.strictEqual(guard.getState().storedBytes, size);
    passed++;
  } catch (err) {
    console.error('Test 12 failed:', err);
    failed++;
  }

  // Test 13: Small binary (<256 KiB) still goes to R2 based on type
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const guard = new R2UsageGuard(new MockStorage());
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    const binPayload = new Uint8Array([1, 2, 3, 4, 5]);
    const art = await r2Storage.saveArtifact('task-test', 'model.bin', binPayload, 'binary');
    assert.ok(art.r2Key, 'Binary artifact type must always route to R2');
    assert.strictEqual(mockR2.putCallCount, 1);
    passed++;
  } catch (err) {
    console.error('Test 13 failed:', err);
    failed++;
  }

  // Test 14: Retrieved payload SHA-256 matches original
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const guard = new R2UsageGuard(new MockStorage());
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    const originalData = new TextEncoder().encode('Hello DevSpace R2 Cost Guard');
    const art = await r2Storage.saveArtifact('task-hash', 'test.bin', originalData, 'binary');
    const retrieved = await r2Storage.getArtifact(art.metadata);
    assert.ok(retrieved);
    const retrievedBytes = new Uint8Array(retrieved!);

    const hashBuffer = await crypto.subtle.digest('SHA-256', retrievedBytes);
    const sha256 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    assert.strictEqual(sha256, art.metadata.sha256, 'Retrieved payload SHA-256 must match original');
    passed++;
  } catch (err) {
    console.error('Test 14 failed:', err);
    failed++;
  }

  // Test 15: No public R2 URL is generated in metadata or download links
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const guard = new R2UsageGuard(new MockStorage());
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    const art = await r2Storage.saveArtifact('task-sec', 'secret.bin', new Uint8Array([9, 8, 7]), 'binary');
    const objectKey = r2Storage.objectKey(art.metadata);
    assert.ok(!objectKey.includes('http://'), 'Object key must not be a public URL');
    assert.ok(!objectKey.includes('https://'), 'Object key must not be a public URL');
    assert.ok(!objectKey.includes('r2.dev'), 'Object key must not contain r2.dev');
    passed++;
  } catch (err) {
    console.error('Test 15 failed:', err);
    failed++;
  }

  // Test 16: Reservation-first PUT Failure Window: Accounting save fails before PUT -> R2.put is NOT called
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const mockStorage = new MockStorage();
    mockStorage.failNextSave = true; // Disk / SQLite failure
    const guard = new R2UsageGuard(mockStorage);
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    let threw = false;
    try {
      await r2Storage.saveArtifactPayload(
        { id: 'art-fail-save', taskId: 't1', name: 'data.bin', type: 'binary', sizeBytes: 500000, sha256: 'mock', createdAt: Date.now() },
        new Uint8Array(500000)
      );
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('STORAGE_DISK_FULL'));
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(mockR2.putCallCount, 0, 'R2.put MUST NOT be called if durable reservation save fails');
    passed++;
  } catch (err) {
    console.error('Test 16 failed:', err);
    failed++;
  }

  // Test 17: Reservation-first PUT Crash Window: Reservation persisted -> R2.put succeeds -> simulated crash after R2.put -> durable accounting is already conservative & correct
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const mockStorage = new MockStorage();
    const guard = new R2UsageGuard(mockStorage);
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    const artifactSize = 400000;
    await r2Storage.saveArtifactPayload(
      { id: 'art-crash', taskId: 't1', name: 'data.bin', type: 'binary', sizeBytes: artifactSize, sha256: 'mock', createdAt: Date.now() },
      new Uint8Array(artifactSize)
    );

    // Simulate Worker / DO restart from persisted storage
    const recoveredGuard = new R2UsageGuard(mockStorage);
    await recoveredGuard.hydrate();
    const state = recoveredGuard.getState();
    assert.strictEqual(state.storedBytes, artifactSize, 'Durable accounting already contains reserved bytes');
    assert.strictEqual(state.objectCount, 1);
    assert.strictEqual(state.classAOperations, 1);
    passed++;
  } catch (err) {
    console.error('Test 17 failed:', err);
    failed++;
  }

  // Test 18: Reservation-first GET Failure Window: Accounting save fails before GET -> R2.get is NOT called
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const mockStorage = new MockStorage();
    mockStorage.failNextSave = true;
    const guard = new R2UsageGuard(mockStorage);
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    let threw = false;
    try {
      await r2Storage.getArtifactContent('tasks/t1/art-test');
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('STORAGE_DISK_FULL'));
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(mockR2.getCallCount, 0, 'R2.get MUST NOT be called if durable Class B reservation fails');
    passed++;
  } catch (err) {
    console.error('Test 18 failed:', err);
    failed++;
  }

  // Test 19: Reservation-first GET Network Error Window: Reservation persisted -> R2.get fails -> Class B remains counted
  try {
    const mockR2 = new TrackingMockR2Bucket();
    mockR2.failNextGet = true; // R2 network fails
    const mockStorage = new MockStorage();
    const guard = new R2UsageGuard(mockStorage);
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    let threw = false;
    try {
      await r2Storage.getArtifactContent('tasks/t1/art-test');
    } catch (err: any) {
      threw = true;
      assert.ok(err.message.includes('R2_NETWORK_TIMEOUT'));
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(guard.getState().classBOperations, 1, 'Class B op must remain counted even if R2.get fails');
    passed++;
  } catch (err) {
    console.error('Test 19 failed:', err);
    failed++;
  }

  // Test 20: Concurrency Race Test: Remaining quota allows only one 15 MiB PUT. Two concurrent PUTs via Promise.all.
  try {
    const mockR2 = new TrackingMockR2Bucket();
    const mockStorage = new MockStorage();
    mockStorage.saved = {
      monthKey: '2026-08',
      storedBytes: 2 * 1024 * 1024 * 1024 - 16 * 1024 * 1024, // Remaining space = 16 MiB
      objectCount: 10,
      classAOperations: 10,
      classBOperations: 5
    };
    const guard = new R2UsageGuard(mockStorage);
    await guard.hydrate();
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2, guard);

    const fifteenMb = 15 * 1024 * 1024; // 15 MiB
    const p1 = r2Storage.saveArtifactPayload(
      { id: 'art-c1', taskId: 't1', name: 'c1.bin', type: 'binary', sizeBytes: fifteenMb, sha256: 'm1', createdAt: Date.now() },
      new Uint8Array(fifteenMb)
    );
    const p2 = r2Storage.saveArtifactPayload(
      { id: 'art-c2', taskId: 't1', name: 'c2.bin', type: 'binary', sizeBytes: fifteenMb, sha256: 'm2', createdAt: Date.now() },
      new Uint8Array(fifteenMb)
    );

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'Exactly ONE concurrent PUT must succeed');
    assert.strictEqual(rejected.length, 1, 'Exactly ONE concurrent PUT must fail');
    assert.ok((rejected[0] as PromiseRejectedResult).reason.message.includes('R2_USAGE_LIMIT_EXCEEDED'));
    assert.strictEqual(mockR2.putCallCount, 1, 'R2.put must be called exactly 1 time');
    passed++;
  } catch (err) {
    console.error('Test 20 failed:', err);
    failed++;
  }

  // Test 21: Concurrent Class A limit exhaustion
  try {
    const mockStorage = new MockStorage();
    mockStorage.saved = {
      monthKey: '2026-08',
      storedBytes: 1024,
      objectCount: 10,
      classAOperations: 99999, // 1 Class A op remaining
      classBOperations: 5
    };
    const guard = new R2UsageGuard(mockStorage);
    await guard.hydrate();

    const p1 = guard.reservePut(100);
    const p2 = guard.reservePut(100);

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'Exactly ONE concurrent Class A operation must succeed');
    assert.strictEqual(rejected.length, 1, 'Second concurrent Class A operation must fail with quota error');
    assert.ok((rejected[0] as PromiseRejectedResult).reason.message.includes('R2_USAGE_LIMIT_EXCEEDED'));
    passed++;
  } catch (err) {
    console.error('Test 21 failed:', err);
    failed++;
  }

  // Test 22: Malformed config env values fallback to conservative built-in HARD_DEFAULT
  try {
    const malformedInputs = [
      undefined,
      null,
      '',
      'invalid-string',
      NaN,
      Infinity,
      -1000,
      0,
      '0',
      '-500'
    ];

    for (const val of malformedInputs) {
      const parsed = parseSafeLimit(val, HARD_IMMUTABLE_LIMITS.maxTotalStoredBytes);
      assert.strictEqual(parsed, HARD_IMMUTABLE_LIMITS.maxTotalStoredBytes, `Malformed value ${val} must resolve to HARD_DEFAULT`);
    }

    const effective = buildEffectiveLimits({
      maxTotalStoredBytes: 'not-a-number',
      maxSingleArtifactBytes: -5,
      maxLiveObjectCount: NaN,
      maxClassAOperationsMonth: null,
      maxClassBOperationsMonth: undefined,
      retentionDays: 0
    });

    assert.strictEqual(effective.maxTotalStoredBytes, HARD_IMMUTABLE_LIMITS.maxTotalStoredBytes);
    assert.strictEqual(effective.maxSingleArtifactBytes, HARD_IMMUTABLE_LIMITS.maxSingleArtifactBytes);
    assert.strictEqual(effective.maxLiveObjectCount, HARD_IMMUTABLE_LIMITS.maxLiveObjectCount);
    assert.strictEqual(effective.maxClassAOperationsMonth, HARD_IMMUTABLE_LIMITS.maxClassAOperationsMonth);
    assert.strictEqual(effective.maxClassBOperationsMonth, HARD_IMMUTABLE_LIMITS.maxClassBOperationsMonth);
    assert.strictEqual(effective.retentionDays, HARD_IMMUTABLE_LIMITS.retentionDays);
    passed++;
  } catch (err) {
    console.error('Test 22 failed:', err);
    failed++;
  }

  // Test 23: Environment configuration cannot raise built-in hard ceilings
  try {
    const attemptedHigherLimits = buildEffectiveLimits({
      maxTotalStoredBytes: 20 * 1024 * 1024 * 1024, // 20 GiB (attempted higher)
      maxSingleArtifactBytes: 50 * 1024 * 1024,     // 50 MiB (attempted higher)
      maxLiveObjectCount: 10000,                    // 10000 (attempted higher)
      maxClassAOperationsMonth: 500000,             // 500000 (attempted higher)
      maxClassBOperationsMonth: 5000000,            // 5000000 (attempted higher)
      retentionDays: 30                             // 30 days (attempted higher)
    });

    assert.strictEqual(attemptedHigherLimits.maxTotalStoredBytes, HARD_IMMUTABLE_LIMITS.maxTotalStoredBytes, 'Cannot raise 2 GiB hard ceiling');
    assert.strictEqual(attemptedHigherLimits.maxSingleArtifactBytes, HARD_IMMUTABLE_LIMITS.maxSingleArtifactBytes, 'Cannot raise 20 MiB hard ceiling');
    assert.strictEqual(attemptedHigherLimits.maxLiveObjectCount, HARD_IMMUTABLE_LIMITS.maxLiveObjectCount, 'Cannot raise 2000 object hard ceiling');
    assert.strictEqual(attemptedHigherLimits.maxClassAOperationsMonth, HARD_IMMUTABLE_LIMITS.maxClassAOperationsMonth, 'Cannot raise 100k Class A hard ceiling');
    assert.strictEqual(attemptedHigherLimits.maxClassBOperationsMonth, HARD_IMMUTABLE_LIMITS.maxClassBOperationsMonth, 'Cannot raise 1M Class B hard ceiling');
    assert.strictEqual(attemptedHigherLimits.retentionDays, HARD_IMMUTABLE_LIMITS.retentionDays, 'Cannot raise 7 day retention hard ceiling');

    // Environment CAN lower limits:
    const loweredLimits = buildEffectiveLimits({
      maxTotalStoredBytes: 1024 * 1024 * 1024, // 1 GiB
      maxSingleArtifactBytes: 10 * 1024 * 1024 // 10 MiB
    });
    assert.strictEqual(loweredLimits.maxTotalStoredBytes, 1024 * 1024 * 1024, 'Can lower total limit');
    assert.strictEqual(loweredLimits.maxSingleArtifactBytes, 10 * 1024 * 1024, 'Can lower single artifact limit');
    passed++;
  } catch (err) {
    console.error('Test 23 failed:', err);
    failed++;
  }

  return { passed, failed };
}
