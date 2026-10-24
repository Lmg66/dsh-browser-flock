export class FlockError extends Error {
  constructor(code, message, { retryable = false, recoveryHint, details } = {}) {
    super(message);
    this.name = 'FlockError';
    this.code = code;
    this.retryable = retryable;
    this.recoveryHint = recoveryHint;
    this.details = details;
  }
}

export function invariant(condition, code, message, options) {
  if (!condition) throw new FlockError(code, message, options);
}

export function failure(error) {
  if (!(error instanceof FlockError)) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'The operation failed unexpectedly.', retryable: false } };
  }
  return { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable,
    ...(error.recoveryHint ? { recovery_hint: error.recoveryHint } : {}) },
    ...(error.details ? { data: error.details } : {}) };
}
