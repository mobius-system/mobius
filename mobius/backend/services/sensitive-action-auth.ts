import bcrypt from 'bcryptjs';
import { Users } from '../repositories/users';

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;

interface FailureBucket {
  failures: number;
  resetAt: number;
}

export class SensitiveActionRateLimiter {
  private readonly buckets = new Map<string, FailureBucket>();
  private operations = 0;

  constructor(
    private readonly windowMs = DEFAULT_WINDOW_MS,
    private readonly maxFailures = DEFAULT_MAX_FAILURES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    this.sweepOccasionally();
    const bucket = this.activeBucket(key);
    if (!bucket || bucket.failures < this.maxFailures) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000)),
    };
  }

  recordFailure(key: string): void {
    const current = this.activeBucket(key);
    if (current) {
      current.failures += 1;
      return;
    }
    this.buckets.set(key, { failures: 1, resetAt: this.now() + this.windowMs });
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }

  private activeBucket(key: string): FailureBucket | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    if (bucket.resetAt <= this.now()) {
      this.buckets.delete(key);
      return null;
    }
    return bucket;
  }

  private sweepOccasionally(): void {
    this.operations += 1;
    if (this.operations % 100 !== 0) return;
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

const limiter = new SensitiveActionRateLimiter();

export type SensitivePasswordResult =
  | { ok: true }
  | { ok: false; code: 'password_required' | 'password_invalid' | 'rate_limited'; retry_after_seconds?: number };

export function verifySensitiveActionPassword(args: {
  userId: string;
  password: unknown;
  clientAddress: string;
}): SensitivePasswordResult {
  const userId = String(args.userId || '').trim();
  const password = typeof args.password === 'string' ? args.password : '';
  const clientAddress = String(args.clientAddress || 'unknown').trim() || 'unknown';
  if (!password) return { ok: false, code: 'password_required' };

  const key = `${userId}\n${clientAddress}`;
  const limit = limiter.check(key);
  if (!limit.allowed) {
    return { ok: false, code: 'rate_limited', retry_after_seconds: limit.retryAfterSeconds };
  }

  const user = Users.findById(userId);
  const valid = !!user?.password_hash && bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    limiter.recordFailure(key);
    return { ok: false, code: 'password_invalid' };
  }
  limiter.clear(key);
  return { ok: true };
}
