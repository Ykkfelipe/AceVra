import { randomUUID } from "node:crypto";

import type { LeaseAuthority, LeaseRecord } from "./contract.js";

/** Single service-owned serial authority. Runtime maps remain projections only. */
export function createLeaseAuthority(): LeaseAuthority {
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
    commitAcquire: (leaseId, helperRequirement) =>
      serial(() => {
        if (!current || current.leaseId !== leaseId || current.state !== "reserving") {
          throw new Error("CUA lease generation is no longer admissible");
        }
        current = { ...current, state: "active", helperRequirement };
        return current;
      }),
    release: (leaseId) =>
      serial(() => {
        if (!current || current.leaseId !== leaseId) throw new Error("CUA lease is not active");
        current = { ...current, state: "released" };
        return current;
      }),
    stop: () =>
      serial(() => {
        if (!current || current.state === "released" || current.state === "stopped") {
          return { status: "already_stopped" as const, record: current };
        }
        current = { ...current, state: "stopped" };
        return { status: "released" as const, record: current };
      }),
    getStatus: () => current,
    close: async () => {
      current = undefined;
      await operation;
    },
  };
}
