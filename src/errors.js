export class OzonError extends Error {
  name = 'OzonError';
}

export class ValidationError extends Error {
  name = 'ValidationError';
}

export class ReadOnlyError extends Error {
  name = 'ReadOnlyError';
}

export class RateLimitError extends Error {
  name = 'RateLimitError';
}
