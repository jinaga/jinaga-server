import { validateSpecificationForCsv, extractValueByLabel, formatValueForCsv } from '../../src/http/csv-validator';
import { Specification, SpecificationParser, CompositeProjection } from 'jinaga';

describe('CSV Validator', () => {
    describe('validateSpecificationForCsv', () => {
        // Helper function to create a specification from declarative syntax
        function GivenSpecificationFromInput(input: string): Specification {
            const parser = new SpecificationParser(input);
            return parser.parseSpecification();
        }

        it('should accept flat field projections', () => {
            const input = `(root: Root) {
                successor: Successor [
                    successor->root: Root = root
                ]
            } => {
                name = successor.name
                count = successor.count
            }`;
            const specification = GivenSpecificationFromInput(input);

            const metadata = validateSpecificationForCsv(specification);
            
            expect(metadata.isValid).toBe(true);
            expect(metadata.headers).toEqual(['name', 'count']);
            expect(metadata.errors).toEqual([]);
        });

        // Acceptance tests for future hash/timestamp support
        it('should accept hash projections', () => {
            const input = `(root: Root) {
                successor: Successor [
                    successor->root: Root = root
                ]
            } => {
                hash = #successor
            }`;
            const specification = GivenSpecificationFromInput(input);

            const metadata = validateSpecificationForCsv(specification);
            
            expect(metadata.errors).toEqual([]);
            expect(metadata.isValid).toBe(true);
            expect(metadata.headers).toEqual(['hash']);
        });

        it('should accept timestamp projections', () => {
            const input = `(root: Root) {
                successor: Successor [
                    successor->root: Root = root
                ]
            } => {
                timestamp = @successor
            }`;
            const specification = GivenSpecificationFromInput(input);

            const metadata = validateSpecificationForCsv(specification);
            
            expect(metadata.isValid).toBe(true);
            expect(metadata.headers).toEqual(['timestamp']);
        });

        it('should reject nested projections', () => {
            const specification = GivenSpecificationFromInput(`(root: Root) {
                successor: Successor [
                    successor->root: Root = root
                ]
            } => {
                nested = {
                    grandchild: Grandchild [
                        grandchild->successor: Successor = successor
                    ]
                } => {
                    name = grandchild.name
                }
            }`);

            const metadata = validateSpecificationForCsv(specification);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors.length).toBeGreaterThan(0);
            expect(metadata.errors).toEqual([`Unsupported projection type of field 'nested' for CSV export. Only flat field projections are allowed.`]);
        });

        it('should reject fact projections', () => {
            const specification = GivenSpecificationFromInput(`(root: Root) {
                successor: Successor [
                    successor->root: Root = root
                ]
            } => {
                successor = successor
            }`);

            const metadata = validateSpecificationForCsv(specification);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors.length).toBeGreaterThan(0);
            expect(metadata.errors).toEqual([`Unsupported projection type of field 'successor' for CSV export. Only flat field projections are allowed.`]);
        });

        it('should reject non-composite top-level projections', () => {
            const specification = GivenSpecificationFromInput(`(root: Root) {
                successor: Successor [
                    successor->root: Root = root
                ]
            } => successor.name`);

            const metadata = validateSpecificationForCsv(specification);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors).toContain('Specification projection must be composite for CSV export');
        });

        it('should reject specification without projection', () => {
            const specification = GivenSpecificationFromInput(`(root: Root) {
                successor: Successor [
                    successor->root: Root = root
                ]
            }`);

            const metadata = validateSpecificationForCsv(specification);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors).toEqual(['Specification must have a projection for CSV export']);
        });

        it('should handle mixed valid and invalid projections', () => {
            const specification = GivenSpecificationFromInput(`(root: Root) {
                successor: Successor [
                    successor->root: Root = root
                ]
            } => {
                name = successor.name
                nested = {
                    grandchild: Grandchild [
                        grandchild->successor: Successor = successor
                    ]
                } => {
                    name = grandchild.name
                }
                count = successor.count
                successor = successor
            }`);

            const metadata = validateSpecificationForCsv(specification);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.headers).toEqual(['name', 'count']); // Only valid field projections
            expect(metadata.errors).toEqual([
                `Unsupported projection type of field 'nested' for CSV export. Only flat field projections are allowed.`,
                `Unsupported projection type of field 'successor' for CSV export. Only flat field projections are allowed.`
            ]);
        });
    });

    describe('extractValueByLabel', () => {
        it('should extract direct property', () => {
            const result = { name: 'Alice', age: 30 };
            
            expect(extractValueByLabel(result, 'name')).toBe('Alice');
            expect(extractValueByLabel(result, 'age')).toBe(30);
        });

        it('should return null for missing properties', () => {
            const result = { name: 'Alice' };
            
            expect(extractValueByLabel(result, 'age')).toBeNull();
        });

        it('should return null for null result', () => {
            expect(extractValueByLabel(null, 'name')).toBeNull();
        });

        it('should return null for undefined result', () => {
            expect(extractValueByLabel(undefined, 'name')).toBeNull();
        });
    });

    describe('formatValueForCsv', () => {
        it('should return empty string for null', () => {
            expect(formatValueForCsv(null)).toBe('');
        });

        it('should return empty string for undefined', () => {
            expect(formatValueForCsv(undefined)).toBe('');
        });

        it('should format Date as ISO string', () => {
            const date = new Date('2024-01-15T10:30:00.000Z');
            expect(formatValueForCsv(date)).toBe('2024-01-15T10:30:00.000Z');
        });

        it('should format boolean as string', () => {
            expect(formatValueForCsv(true)).toBe('true');
            expect(formatValueForCsv(false)).toBe('false');
        });

        it('should convert primitives to string', () => {
            expect(formatValueForCsv('hello')).toBe('hello');
            expect(formatValueForCsv(42)).toBe('42');
            expect(formatValueForCsv(3.14)).toBe('3.14');
        });
    });
});
