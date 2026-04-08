export class PacificaError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly rawBody?: string,
  ) {
    super(message);
    this.name = 'PacificaError';
  }
}

export class PacificaAuthError extends PacificaError {
  constructor(message = 'Authentication failed') {
    super(message, 401);
    this.name = 'PacificaAuthError';
  }
}

export class PacificaRateLimitError extends PacificaError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429);
    this.name = 'PacificaRateLimitError';
  }
}

export class PacificaNotFoundError extends PacificaError {
  constructor(message = 'Resource not found') {
    super(message, 404);
    this.name = 'PacificaNotFoundError';
  }
}

export class PacificaValidationError extends PacificaError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'PacificaValidationError';
  }
}

export class PacificaServerError extends PacificaError {
  constructor(message = 'Internal server error') {
    super(message, 500);
    this.name = 'PacificaServerError';
  }
}