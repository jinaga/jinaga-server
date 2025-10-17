import { Specification } from 'jinaga';
import { CsvMetadata, ProjectionComponent, ProjectionComponentType } from './csv-metadata';

/**
 * Validates a specification for CSV compatibility.
 * Returns metadata including headers and validation results.
 * 
 * CSV requires flat projections with single-valued components:
 * - ✅ Fields (scalar values)
 * - ✅ Hashes
 * - ✅ Type names
 * - ✅ Predecessor fields (e.g., item.parent.name)
 * - ❌ Arrays (existential quantifiers)
 * - ❌ Nested objects (composite projections)
 */
export function validateSpecificationForCsv(specification: Specification): CsvMetadata {
    const headers: string[] = [];
    const projectionLabels = new Map<string, string>();
    const errors: string[] = [];

    // Check if specification has projections
    if (!specification.projection) {
        return {
            headers: [],
            projectionLabels,
            isValid: false,
            errors: ['Specification has no projections']
        };
    }

    // Handle both array and object projection formats
    const projections = Array.isArray(specification.projection) 
        ? specification.projection 
        : Object.entries(specification.projection).map(([name, proj]) => ({
            ...proj,
            name
        }));

    if (projections.length === 0) {
        return {
            headers: [],
            projectionLabels,
            isValid: false,
            errors: ['Specification has no projections']
        };
    }

    // Analyze each projection component
    for (const projection of projections) {
        const component = analyzeProjectionComponent(projection);

        if (component.isValid) {
            headers.push(component.label);
            projectionLabels.set(component.label, component.label);
        } else {
            errors.push(
                `Projection "${component.label}" is invalid for CSV: ${component.reason}`
            );
        }
    }

    return {
        headers,
        projectionLabels,
        isValid: errors.length === 0,
        errors
    };
}

/**
 * Analyzes a single projection component to determine if it's CSV-compatible
 */
function analyzeProjectionComponent(projection: any): ProjectionComponent {
    // Get the label/name of the projection
    const label = projection.name || projection.label || '<unnamed>';
    
    // Check if it's an array (existential quantifier)
    // In Jinaga specs, arrays are projections with multiple values
    if (projection.type === 'specification') {
        // This is a nested specification (array or nested object)
        return {
            label,
            type: 'array',
            isValid: false,
            reason: 'Array projections (existential quantifiers) are not supported in CSV format. CSV requires flat, single-valued projections.'
        };
    }

    // Check if it's a composite projection (nested object)
    if (projection.projection && typeof projection.projection === 'object') {
        const hasNestedProjections = Array.isArray(projection.projection) 
            ? projection.projection.length > 0
            : Object.keys(projection.projection).length > 0;
            
        if (hasNestedProjections) {
            return {
                label,
                type: 'nested',
                isValid: false,
                reason: 'Nested object projections are not supported in CSV format. Flatten the projection by using separate labeled fields (e.g., userName: user.name, userEmail: user.email).'
            };
        }
    }

    // Check if it's a composite projection object format
    if (projection.composite && Array.isArray(projection.composite)) {
        return {
            label,
            type: 'nested',
            isValid: false,
            reason: 'Composite projections are not supported in CSV format. Use individual field projections instead.'
        };
    }

    // Determine the type of scalar projection
    const type = determineScalarType(projection);
    
    if (type === 'unknown') {
        return {
            label,
            type,
            isValid: false,
            reason: 'Unknown projection type. CSV supports only simple fields, hashes, types, and predecessor fields.'
        };
    }

    return {
        label,
        type,
        isValid: true
    };
}

/**
 * Determines the type of a scalar projection
 */
function determineScalarType(projection: any): ProjectionComponentType {
    // Check for hash projection
    if (projection.type === 'hash' || projection.hash === true) {
        return 'hash';
    }

    // Check for type projection
    if (projection.type === 'type') {
        return 'type';
    }

    // Check for field projection (most common)
    if (projection.type === 'field' || projection.field || projection.fieldName) {
        return 'field';
    }

    // Check for predecessor projection (path traversal)
    if (projection.type === 'predecessor' || (projection.path && projection.path.length > 0)) {
        return 'predecessor';
    }

    // If it has a simple structure, assume it's a field
    if (projection.name && !projection.projection && !projection.type) {
        return 'field';
    }

    return 'unknown';
}

/**
 * Extract value from result object using projection label
 */
export function extractValueByLabel(result: any, label: string): any {
    if (result == null) {
        return null;
    }
    
    // Direct property access
    if (label in result) {
        return result[label];
    }
    
    // Try nested access with dot notation
    const parts = label.split('.');
    let value = result;
    
    for (const part of parts) {
        if (value == null) {
            return null;
        }
        value = value[part];
    }
    
    // Return null instead of undefined
    return value !== undefined ? value : null;
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
    
    // Handle fact references (objects with type and hash)
    if (typeof value === 'object' && value.type && value.hash) {
        return value.hash;
    }
    
    // Handle other objects
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    
    // Default: convert to string
    return String(value);
}
