import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_MAX_ATTEMPTS,
  PROVIDER_QUOTA_RECOVERY_MAX_WAIT_MS,
  providerQuotaRecoveryBackoffMs,
  providerQuotaRecoveryExhaustion,
  readProviderQuotaRecoveryProgress,
} from "./provider-quota-recovery.js";

const HOUR = 60 * 60 * 1000;

describe("provider-quota recovery bounds", () => {
  it("backs off 1h, 2h, 4h, then every 6h when no reset time is known", () => {
    expect([0, 1, 2, 3, 4, 20].map(providerQuotaRecoveryBackoffMs)).toEqual([
      HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR,
    ]);
  });

  it("starts a new wait at a run that was not a quota-recovery replacement", () => {
    const createdAt = new Date("2026-10-11T04:06:32.179Z");
    const progress = readProviderQuotaRecoveryProgress({
      createdAt,
      // The prod shape: the second spent transient retry, with stale quota keys.
      contextSnapshot: {
        retryReason: "transient_failure",
        scheduledRetryAttempt: 2,
        providerQuotaWaitStartedAt: "2026-09-01T00:00:00.000Z",
      },
    }, new Date("2026-10-13T10:00:00.000Z"));
    expect(progress).toEqual({
      attempts: 0,
      waitStartedAt: createdAt,
      deadline: new Date(createdAt.getTime() + PROVIDER_QUOTA_RECOVERY_MAX_WAIT_MS),
    });
  });

  it("continues the wait of a quota-recovery replacement", () => {
    const progress = readProviderQuotaRecoveryProgress({
      createdAt: new Date("2026-10-14T00:00:00.000Z"),
      contextSnapshot: {
        retryReason: "provider_quota_recovery",
        scheduledRetryAttempt: 3,
        providerQuotaWaitStartedAt: "2026-10-11T04:06:32.179Z",
      },
    }, new Date("2026-10-14T00:00:00.000Z"));
    expect(progress.attempts).toBe(3);
    expect(progress.waitStartedAt.toISOString()).toBe("2026-10-11T04:06:32.179Z");
    expect(progress.deadline.toISOString()).toBe("2026-10-19T04:06:32.179Z");
  });

  it("is exhausted by its attempt bound or its deadline", () => {
    const waitStartedAt = new Date("2026-10-11T00:00:00.000Z");
    const deadline = new Date(waitStartedAt.getTime() + PROVIDER_QUOTA_RECOVERY_MAX_WAIT_MS);
    const before = new Date(deadline.getTime() - 1);
    expect(providerQuotaRecoveryExhaustion({ attempts: 5, waitStartedAt, deadline }, before)).toBeNull();
    expect(providerQuotaRecoveryExhaustion({ attempts: 5, waitStartedAt, deadline }, deadline))
      .toBe("timeout_exceeded");
    expect(providerQuotaRecoveryExhaustion(
      { attempts: PROVIDER_QUOTA_RECOVERY_MAX_ATTEMPTS, waitStartedAt, deadline },
      before,
    )).toBe("max_attempts_exhausted");
  });
});
