/**
 * Errors from the face engine that callers handle differently from a single photo failing (phase 6). Kept in
 * their own tiny module so the scanner can recognise them without loading the engine.
 */

/** The face models couldn't be downloaded or didn't pass their integrity check. Retried later, not per photo. */
export class ModelError extends Error {
  constructor(message = 'The face models couldn’t be loaded.') {
    super(message);
    this.name = 'ModelError';
  }
}

/** The face worker was shut down (session end, or face grouping turned off) while this call waited. */
export class FacesStoppedError extends Error {
  constructor() {
    super('The face engine was stopped.');
    this.name = 'FacesStoppedError';
  }
}
