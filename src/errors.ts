export class KimiApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'KimiApiError';
  }
}

export class KimiNetworkError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message, { cause });
    this.name = 'KimiNetworkError';
  }
}

export class BridgeToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BridgeToolError';
  }
}
