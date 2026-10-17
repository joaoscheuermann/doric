import type { NextFunction, Request, Response } from 'express';

export const sendError = (
  response: Response,
  status: number,
  code: string,
  message: string,
) => response.status(status).json({ error: { code, message } });

/** Replaces all unexpected HTTP failures with a stable, sanitized envelope. */
export const handleHttpError = (
  _error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
) =>
  sendError(
    response,
    500,
    'internal_error',
    'The request could not be completed.',
  );
