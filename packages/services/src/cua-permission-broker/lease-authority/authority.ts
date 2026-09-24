import { randomUUID } from "node:crypto";

import type { LeaseAuthority, LeaseRecord } from "./contract.js";

export interface LeaseAuthorityOptions {
  /** Releases the observed native Helper lease and resolves only after terminal cleanup. */
  releaseHelper?: (record: LeaseRecord) => Promise<void>;
}

/** Single service-owned serial authority. Runtime maps remain projections only. */
export function createLeaseAuthority(options: LeaseAuthorityOptions = {}): LeaseAuthority {
  let current: LeaseRecord | undefined;
  let nextGeneration = 1;
  let operation: Promise<unknown> = Promise.resolve();

  const serial = <T>(task: () => T | Promise<T>): Promise<T> => {
    const result = operation.then(task, task);
    operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    beginAcquire: (owner) =>
      serial(() => {
        if (current && (current.state === "reserving" || current.state === "active")) {
          throw new Error("CUA lease already admitted");
        }
        current = {
          leaseId: randomUUID(),
          ownerSession: owner.session,
          ownerTask: owner.task,
          generation: nextGeneration++,
          state: "reserving",
        };
        return current;
      }),
    commitAcquire: (leaseId, helperLeaseId, helperRequirement) =>
      serial(() => {
        if (!current || current.leaseId !== leaseId || current.state !== "reserving") {
          throw new Error("CUA lease generation is no longer admissible");
        }
        current = { ...current, state: "active", helperLeaseId, helperRequirement };
        return current;
      }),
    release: (leaseId) =>
      serial(() => {
        if (!current || current.leaseId !== leaseId) throw new Error("CUA lease is not active");
        if (current.state === "released" || current.state === "stopped") return current;
        current = { ...current, state: "released" };
        return current;
      }),
    stop: () =>
      serial(async () => {
        if (!current || current.state === "released" || current.state === "stopped") {
          return { status: "already_stopped" as const, record: current };
        }
        const stopping = { ...current, state: "stopped" as const };
        current = stopping;
        if (stopping.helperLeaseId && options.releaseHelper) {
          await options.releaseHelper(stopping);
        }
        return { status: "released" as const, record: stopping };
      }),
    getStatus: () => current,
    close: async () => {
      current = undefined;
      await operation;
    },
  };
}
