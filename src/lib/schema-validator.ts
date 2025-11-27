/**
 * BCMR Schema Validator
 * Fetches BCMR JSON schema and validates JSON content against it
 */

import { Ajv, type ValidateFunction } from 'ajv';

/**
 * Schema cache - stored in memory for session duration
 */
interface SchemaCache {
  schema: any;
  validator: ValidateFunction;
  lastFetched: number;
}

let cachedSchema: SchemaCache | null = null;

// BCMR v2 schema URL
const BCMR_SCHEMA_URL =
  'https://cashtokens.org/assets/files/bcmr-v2.schema-66c8b9f4fd714951906dbe7cf2bf8560.json';

// Fallback schema URLs (in case primary fails)
const FALLBACK_SCHEMA_URLS = [
  'https://raw.githubusercontent.com/bitjson/chip-bcmr/master/bcmr-v2.schema.json',
];

/**
 * Fetch BCMR schema from cashtokens.org or fallback sources
 * Caches in memory for entire session duration (schemas don't change)
 *
 * @param timeoutMs Timeout for schema fetch in milliseconds
 * @returns Compiled Ajv validator function
 */
async function fetchBCMRSchema(timeoutMs: number = 5000): Promise<ValidateFunction> {
  // Return cached validator if available (valid for entire process lifetime)
  // Schemas don't change during a session
  if (cachedSchema) {
    return cachedSchema.validator;
  }

  // Try primary URL first, then fallbacks
  const urlsToTry = [BCMR_SCHEMA_URL, ...FALLBACK_SCHEMA_URLS];

  for (const url of urlsToTry) {
    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`Failed to fetch schema from ${url}: HTTP ${response.status}`);
        continue;
      }

      const schema = await response.json();

      // Compile schema with Ajv
      const ajv = new Ajv({
        strict: false,      // Don't enforce strict mode (BCMR schema may not be fully strict)
        allErrors: true,    // Collect all errors (not just first)
        verbose: false,     // Don't include schema in error messages (too large)
      });

      const validator = ajv.compile(schema as any);

      // Cache for session
      cachedSchema = {
        schema,
        validator,
        lastFetched: Date.now(),
      };

      return validator;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.warn(`Timeout fetching schema from ${url}`);
      } else {
        console.warn(`Error fetching schema from ${url}:`, error instanceof Error ? error.message : error);
      }
      // Try next URL
    }
  }

  // All URLs failed
  throw new Error('Failed to fetch BCMR schema from all sources');
}

/**
 * Validation result
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validate JSON content against BCMR schema
 *
 * @param json Parsed JSON object to validate
 * @returns Validation result with detailed errors
 */
export async function validateBCMRSchema(json: any): Promise<ValidationResult> {
  try {
    const validator = await fetchBCMRSchema();
    const isValid = validator(json);

    if (isValid) {
      return {
        isValid: true,
        errors: [],
      };
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

    return {
      isValid: false,
      errors,
    };
  } catch (error) {
    // Schema fetch failed - this is a critical error
    // We could either:
    // 1. Fail-open: skip validation, log warning, return valid
    // 2. Fail-closed: treat as validation failure
    //
    // Decision: Fail-open (graceful degradation)
    // Rationale: Network/service issues shouldn't block valid BCMR data
    console.warn('⚠️  Schema validation unavailable:', error instanceof Error ? error.message : error);
    console.warn('⚠️  Skipping schema validation for this JSON (fail-open mode)');

    return {
      isValid: true,
      errors: [],
    };
  }
}

/**
 * Clear cached schema (useful for testing or if schema updates)
 */
export function clearSchemaCache(): void {
  cachedSchema = null;
}
