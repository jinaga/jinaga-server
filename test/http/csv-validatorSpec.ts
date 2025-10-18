import { validateSpecificationForCsv, extractValueByLabel, formatValueForCsv } from '../../src/http/csv-validator';
import { Specification } from 'jinaga';

describe('CSV Validator', () => {
    describe('validateSpecificationForCsv', () => {
        it('should accept flat field projections', () => {
            const spec: Specification = {
                given: [],
                projection: [
                    { name: 'name', type: 'field', field: 'name' },
                    { name: 'count', type: 'field', field: 'count' }
                ]
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(true);
            expect(metadata.headers).toEqual(['name', 'count']);
            expect(metadata.errors).toEqual([]);
        });

        it('should accept hash projections', () => {
            const spec: Specification = {
                given: [],
                projection: [
                    { name: 'itemHash', type: 'hash' }
                ]
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(true);
            expect(metadata.headers).toEqual(['itemHash']);
        });

        it('should accept type projections', () => {
            const spec: Specification = {
                given: [],
                projection: [
                    { name: 'itemType', type: 'type' }
                ]
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(true);
            expect(metadata.headers).toEqual(['itemType']);
        });

        it('should reject array projections (existential quantifiers)', () => {
            const spec: Specification = {
                given: [],
                projection: [
                    { name: 'tags', type: 'specification' }
                ]
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors.length).toBeGreaterThan(0);
            expect(metadata.errors[0]).toContain('Array projections');
        });

        it('should reject nested object projections (array format)', () => {
            const spec: Specification = {
                given: [],
                projection: [
                    {
                        name: 'profile',
                        projection: [
                            { name: 'name', type: 'field' },
                            { name: 'email', type: 'field' }
                        ]
                    }
                ]
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors.length).toBeGreaterThan(0);
            expect(metadata.errors[0]).toContain('Nested object');
        });

        it('should reject nested object projections (object format)', () => {
            const spec: Specification = {
                given: [],
                projection: [
                    {
                        name: 'profile',
                        projection: {
                            name: { type: 'field' },
                            email: { type: 'field' }
                        }
                    }
                ]
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors.length).toBeGreaterThan(0);
            expect(metadata.errors[0]).toContain('Nested object');
        });

        it('should reject composite projections', () => {
            const spec: Specification = {
                given: [],
                projection: [
                    {
                        name: 'user',
                        composite: [
                            { name: 'name' },
                            { name: 'email' }
                        ]
                    }
                ]
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors.length).toBeGreaterThan(0);
            expect(metadata.errors[0]).toContain('Composite');
        });

        it('should handle empty projection', () => {
            const spec: Specification = {
                given: [],
                projection: []
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors).toContain('Specification has no projections');
        });

        it('should handle missing projection', () => {
            const spec: Specification = {
                given: []
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.errors).toContain('Specification has no projections');
        });

        it('should handle mixed valid and invalid projections', () => {
            const spec: Specification = {
                given: [],
                projection: [
                    { name: 'name', type: 'field', field: 'name' },
                    { name: 'tags', type: 'specification' },
                    { name: 'count', type: 'field', field: 'count' }
                ]
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(false);
            expect(metadata.headers).toEqual(['name', 'count']); // Only valid ones
            expect(metadata.errors.length).toBe(1);
            expect(metadata.errors[0]).toContain('tags');
        });

        it('should provide projection labels mapping', () => {
            const spec: Specification = {
                given: [],
                projection: [
                    { name: 'userName', type: 'field', field: 'name' },
                    { name: 'userEmail', type: 'field', field: 'email' }
                ]
            } as any;

            const metadata = validateSpecificationForCsv(spec);
            
            expect(metadata.isValid).toBe(true);
            expect(metadata.projectionLabels.size).toBe(2);
            expect(metadata.projectionLabels.get('userName')).toBe('userName');
            expect(metadata.projectionLabels.get('userEmail')).toBe('userEmail');
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

        it('should extract hash from fact reference', () => {
            const factRef = { type: 'User', hash: 'abc123' };
            expect(formatValueForCsv(factRef)).toBe('abc123');
        });

        it('should stringify other objects', () => {
            const obj = { name: 'Alice', age: 30 };
            expect(formatValueForCsv(obj)).toBe(JSON.stringify(obj));
        });

        it('should convert primitives to string', () => {
            expect(formatValueForCsv('hello')).toBe('hello');
            expect(formatValueForCsv(42)).toBe('42');
            expect(formatValueForCsv(3.14)).toBe('3.14');
        });
    });
});
