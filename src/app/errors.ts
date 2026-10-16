/** Application error with an HTTP-friendly status and a stable machine code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
