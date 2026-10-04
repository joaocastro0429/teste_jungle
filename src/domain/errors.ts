export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
  }
}
export class ConflictError extends DomainError {}
export class NotFoundError extends DomainError {}
