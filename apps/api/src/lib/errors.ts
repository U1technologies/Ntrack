/** Operational error with an HTTP status. Anything else reaching the error handler is a 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'error',
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, message, 'bad_request', details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(401, message, 'unauthorized');
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError(403, message, 'forbidden');
  }
  static notFound(entity = 'Resource') {
    return new AppError(404, `${entity} not found`, 'not_found');
  }
  static conflict(message: string) {
    return new AppError(409, message, 'conflict');
  }
}
