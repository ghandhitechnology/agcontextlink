const STATUS = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  full: 409,
  name_taken: 409,
  ended: 410,
  too_large: 413,
  rate_limited: 429,
} as const;

export type ErrorCode = keyof typeof STATUS;

export class RoomError extends Error {
  readonly code: ErrorCode;
  readonly status: (typeof STATUS)[ErrorCode];

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}

export const ended = () => new RoomError('ended', 'This room has ended.');
