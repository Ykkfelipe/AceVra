export declare const OBSERVE_LIMITS: {
  readonly maxElements: number;
  readonly maxStringCharacters: number;
  readonly maxActionsPerElement: number;
  readonly maxWindows: number;
  readonly maxResultBytes: number;
};

export interface ObservationRedactions {
  stringsTruncated: number;
  pathsRedacted: number;
  pathKeysDropped: string[];
  elementsDropped: number;
}

export interface ObservationLimitsReport {
  maxResultBytes: number;
  exceededBytes: boolean;
}

export declare function sanitizeObservationResult(result: unknown): {
  result: unknown;
  redactions: ObservationRedactions;
  limits: ObservationLimitsReport;
};

export declare function serializedBytes(value: unknown): number;

/** Replace absolute host locations inside free text, e.g. a failure message naming a socket path. */
export declare function redactHostPaths(text: string): string;

export declare function hasDeliverablePayload(result: unknown): boolean;
