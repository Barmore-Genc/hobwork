// Decides when a freshly deployed version counts as completely broken: it has
// not had a single successful invocation, and invocations have kept failing
// for a while. One failure is not enough, because the handler may depend on
// something outside Hobwork that is briefly down.

export type AutoRevertPolicy = {
  // Only failures this soon after the deploy count.
  windowMs: number
  minFailures: number
  // Time between the first and the latest failure.
  minFailingMs: number
}

export const DEFAULT_AUTO_REVERT_POLICY: AutoRevertPolicy = {
  windowMs: 60 * 60 * 1000,
  minFailures: 5,
  minFailingMs: 3 * 60 * 1000,
}

export type DeployHealth = {
  // Returns a reason when the version should be reverted. After that, or after
  // the first success, it never asks again.
  record(ok: boolean, at: number): string | undefined
}

export function createDeployHealth(policy: AutoRevertPolicy, deployedAt: number): DeployHealth {
  let watching = true
  let failures = 0
  let firstFailureAt: number | undefined
  return {
    record(ok, at) {
      if (!watching) return undefined
      if (at - deployedAt > policy.windowMs) {
        watching = false
        return undefined
      }
      if (ok) {
        watching = false
        return undefined
      }
      failures++
      firstFailureAt ??= at
      if (failures >= policy.minFailures && at - firstFailureAt >= policy.minFailingMs) {
        watching = false
        const seconds = Math.round((at - firstFailureAt) / 1000)
        return `${failures} invocations failed over ${seconds}s after the deploy and none succeeded`
      }
      return undefined
    },
  }
}
