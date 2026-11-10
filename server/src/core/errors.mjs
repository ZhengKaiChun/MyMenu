export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}
export function demand(condition, status, code, message) {
  if (!condition) throw new AppError(status, code, message);
}
