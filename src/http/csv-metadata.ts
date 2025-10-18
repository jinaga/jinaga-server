/**
 * Metadata for CSV export derived from specification
 */
export interface CsvMetadata {
    /** Column headers in order (from specification projection labels) */
    headers: string[];
    
    /** Whether the projection is valid for CSV */
    isValid: boolean;
    
    /** Validation errors if any */
    errors: string[];
}

/**
 * Projection component types
 */
export type ProjectionComponentType =
    | 'field'        // Scalar field (string, number, boolean)
    | 'hash'         // Fact hash
    | 'type'         // Fact type
    | 'array'        // Array/collection (invalid for CSV)
    | 'nested'       // Nested object (invalid for CSV)
    | 'unknown';

/**
 * Information about a single projection component
 */
export interface ProjectionComponent {
    label: string;
    type: ProjectionComponentType;
    isValid: boolean;
    reason?: string;
}
