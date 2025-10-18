import { Specification } from 'jinaga';
import { CsvMetadata } from './csv-metadata';

/**
 * Validates a specification for CSV compatibility.
 * Returns metadata including headers and validation results.
 *
 * CSV requires flat projections with single-valued components:
 * - ✅ Fields (scalar values from matched facts)
 * - ✅ Hashes
 * - ✅ Timestamps
 * - ❌ Arrays (nested specifications)
 * - ❌ Nested objects (composite projections)
 */
export function validateSpecificationForCsv(specification: Specification): CsvMetadata {
    const headers: string[] = [];
    const errors: string[] = [];

    // Ensure projection is composite
    if (specification.projection.type !== 'composite') {
        return {
            headers: [],
            isValid: false,
            errors: ['Specification projection must be composite for CSV export']
        };
    }

    // Ensure that the composite has components.
    // An empty composite represents a missing projection.
    if (specification.projection.components.length === 0) {
        return {
            headers: [],
            isValid: false,
            errors: ['Specification must have a projection for CSV export']
        };
    }

    for (const component of specification.projection.components) {
        if (component.type === 'field' || component.type === 'hash' || component.type === 'time') {
            headers.push(component.name);
        }
        else {
            errors.push(`Unsupported projection type of field '${component.name}' for CSV export. Only flat field projections are allowed.`);
        }
    }

    return {
        headers,
        isValid: errors.length === 0,
        errors
    };
}

/**
 * Extract value from result object using projection label.
 * Since CSV only supports flat projections, labels are simple property names.
 */
export function extractValueByLabel(result: any, label: string): any {
    if (result == null) {
        return null;
    }
    
    // Direct property access
    const value = result[label];
    
    // Return null instead of undefined
    return value ?? null;
}

/**
 * Format a value for CSV output
 */
export function formatValueForCsv(value: any): string {
    if (value === null || value === undefined) {
        return '';
    }
    
    // Handle dates
    if (value instanceof Date) {
        return value.toISOString();
    }
    
    // Handle booleans
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    
    // Default: convert to string
    return String(value);
}
