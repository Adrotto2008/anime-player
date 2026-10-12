export class LabError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'LabError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, details = {}) {
  if (!condition) throw new LabError(code, code, details);
}

// Never persist signed URLs, cookies, scripts or provider error bodies.
export function safeError(error) {
  return { code: error?.name === 'AbortError' ? 'cancelled'
    : typeof error?.code === 'string' ? error.code : 'unexpected_error' };
}

export function redactUrl(value) {
  try {
    const u = new URL(value);
    return u.origin + u.pathname;
  } catch { return '[invalid-url]'; }
}
