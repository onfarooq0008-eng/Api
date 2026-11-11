'use strict';

/** An error that maps directly onto an HTTP response. */
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const bad = (code, msg) => new ApiError(400, code, msg);

module.exports = { ApiError, bad };
