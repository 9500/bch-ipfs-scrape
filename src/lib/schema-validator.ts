/**
 * BCMR Schema Validator
 * Validates registry JSON against the BCMR v2 schema.
 *
 * The schema is bundled with the tool (bcmr-v2.schema.json, from the
 * chip-bcmr repository), so validation never depends on the network. An
 * alternative schema can be fetched once per process from BCMR_SCHEMA_URL;
 * if that fails, the bundled schema is used and the failure is remembered
 * for the rest of the session instead of being retried per registry.
 */

import { Ajv, type ValidateFunction } from 'ajv';
import bundledSchema from './bcmr-v2.schema.json' with { type: 'json' };

/** Default timeout for fetching an override schema (ms) */
const SCHEMA_FETCH_TIMEOUT_MS = 5000;

/**
 * Validation result
 * - `unavailable` is set when no validator could be built at all; `isValid`
 *   is then false, `errors` is empty and the caller must not record the
 *   content as validated either way.
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  unavailable?: true;
  reason?: string;
}

interface ValidatorOptions {
  /** Schema to compile instead of the bundled one (tests) */
  schema?: object;
  /** URL of a schema to fetch once per process; null disables the override */
  overrideUrl?: string | null;
  timeoutMs?: number;
}

let options: ValidatorOptions = {};
/** In-flight or settled validator; concurrent callers share one compile and one fetch */
let validatorPromise: Promise<ValidateFunction> | null = null;

function compile(schema: object): ValidateFunction {
  const ajv = new Ajv({
    strict: false,      // Don't enforce strict mode (BCMR schema may not be fully strict)
    allErrors: true,    // Collect all errors (not just first)
    verbose: false,     // Don't include schema in error messages (too large)
  });
  return ajv.compile(schema as any);
}

async function fetchSchema(url: string, timeoutMs: number): Promise<object> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const schema = await response.json();
    if (!schema || typeof schema !== 'object') {
      throw new Error('response is not a JSON object');
    }
    return schema as object;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build the validator once per process. Resolves to the compiled override
 * schema when BCMR_SCHEMA_URL is set and reachable, otherwise to the bundled
 * schema. Rejects only when even the bundled schema cannot be compiled.
 */
async function buildValidator(): Promise<ValidateFunction> {
  const overrideUrl = options.overrideUrl === undefined ? process.env.BCMR_SCHEMA_URL || null : options.overrideUrl;
  const timeoutMs = options.timeoutMs ?? SCHEMA_FETCH_TIMEOUT_MS;

  if (overrideUrl) {
    try {
      const schema = await fetchSchema(overrideUrl, timeoutMs);
      const validator = compile(schema);
      console.log(`Using BCMR schema from ${overrideUrl}`);
      return validator;
    } catch (error) {
      console.warn(
        `Warning: could not use the BCMR schema from ${overrideUrl} (${error instanceof Error ? error.message : error}); using the bundled schema for this session`
      );
    }
  }

  return compile(options.schema ?? bundledSchema);
}

/**
 * Get the compiled validator, building it on first use.
 * Callers that arrive while it is being built wait for the same promise.
 * A build failure is remembered: later callers get the same rejection
 * without rebuilding.
 */
export function getSchemaValidator(): Promise<ValidateFunction> {
  if (!validatorPromise) {
    validatorPromise = buildValidator();
  }
  return validatorPromise;
}

/**
 * Validate JSON content against the BCMR schema
 *
 * @param json Parsed JSON object to validate
 * @returns Validation result with detailed errors, or `unavailable` when no validator exists
 */
export async function validateBCMRSchema(json: any): Promise<ValidationResult> {
  let validator: ValidateFunction;
  try {
    validator = await getSchemaValidator();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { isValid: false, errors: [], unavailable: true, reason };
  }

  if (validator(json)) {
    return { isValid: true, errors: [] };
  }

  // Format errors for readability
  const errors = (validator.errors || []).map((err) => {
    // Format: "/path/to/field message (received: value)"
    const path = err.instancePath || '/';
    const message = err.message || 'validation failed';

    // Include additional context if available
    if (err.params && Object.keys(err.params).length > 0) {
      const params = JSON.stringify(err.params);
      return `${path} ${message} ${params}`;
    }

    return `${path} ${message}`;
  });

  return { isValid: false, errors };
}

/**
 * Reconfigure the validator (tests): drops the cached validator so the next
 * validation builds a new one with these options.
 */
export function configureSchemaValidator(next: ValidatorOptions): void {
  options = next;
  validatorPromise = null;
}
