import { fingerprintIdentity } from '../identity-fingerprint';

describe('fingerprintIdentity', () => {
	it('returns undefined for empty / nullish input so the caller can drop the field', () => {
		expect(fingerprintIdentity(undefined)).toBeUndefined();
		expect(fingerprintIdentity('')).toBeUndefined();
	});

	it('returns a stable 12-char hex prefix for the same input', () => {
		const a = fingerprintIdentity('hello');
		const b = fingerprintIdentity('hello');
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{12}$/);
	});

	it('returns different fingerprints for different inputs', () => {
		expect(fingerprintIdentity('alpha')).not.toBe(fingerprintIdentity('beta'));
	});

	it('does not return the input verbatim or a recognizable prefix of it (non-reversible)', () => {
		const bearer = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEifQ.signaturepart';
		const fp = fingerprintIdentity(bearer);
		expect(fp).toBeDefined();
		expect(bearer).not.toContain(fp as string);
		expect(fp).not.toContain('eyJ');
	});

	it('handles very long inputs without throwing or returning a longer fingerprint', () => {
		const huge = 'x'.repeat(100_000);
		const fp = fingerprintIdentity(huge);
		expect(fp).toMatch(/^[0-9a-f]{12}$/);
	});
});
