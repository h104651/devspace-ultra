export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxRequestsPerWindow: number;
  private windowMs: number;

  constructor(maxRequestsPerWindow = 60, windowMs = 60000) {
    this.maxRequestsPerWindow = maxRequestsPerWindow;
    this.windowMs = windowMs;
  }

  public isAllowed(key: string): { allowed: boolean; retryAfterMs?: number; remaining: number } {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const validTimestamps = timestamps.filter(t => now - t < this.windowMs);

    if (validTimestamps.length >= this.maxRequestsPerWindow) {
      const oldest = validTimestamps[0];
      const retryAfterMs = this.windowMs - (now - oldest);
      return { allowed: false, retryAfterMs, remaining: 0 };
    }

    validTimestamps.push(now);
    this.requests.set(key, validTimestamps);
    return {
      allowed: true,
      remaining: this.maxRequestsPerWindow - validTimestamps.length
    };
  }

  public reset(key?: string): void {
    if (key) {
      this.requests.delete(key);
    } else {
      this.requests.clear();
    }
  }
}
