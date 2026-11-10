export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
export const RETRY_AFTER_CAP_MS = 60_000;
const MESSAGE_LIMIT = 500;

export class ApiError extends Error {
  constructor({ status = null, type, message, requestId = null, retryAfterMs = null, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isPromptTooLong(err) {
  return err instanceof ApiError && err.status === 400 && err.type === 'invalid_request_error' && String(err.message).startsWith('prompt is too long');
}

export function apiErrorFields(err) {
  if (!(err instanceof ApiError)) return null;
  return { status: err.status, type: err.type, message: err.message, request_id: err.requestId };
}

export class StreamFault extends Error {
  constructor(message) {
    super(message);
    this.name = 'StreamFault';
  }
}

export function parseRetryAfter(value) {
  if (value === null || value === undefined || value.trim() === '') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

export async function errorFromResponse(response) {
  const requestId = response.headers.get('request-id');
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  let type = 'http_error';
  let message = text.slice(0, MESSAGE_LIMIT);
  try {
    const parsed = JSON.parse(text);
    if (parsed?.type === 'error' && parsed.error && typeof parsed.error === 'object') {
      type = parsed.error.type ?? type;
      message = parsed.error.message ?? message;
    }
  } catch {}
  if (message === '') message = `HTTP ${response.status}`;
  return new ApiError({ status: response.status, type, message, requestId, retryAfterMs });
}
