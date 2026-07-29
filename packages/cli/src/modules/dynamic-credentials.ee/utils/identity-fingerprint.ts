import { createHash } from 'node:crypto';

/**
 * Fork §10 Phase 2 — log-safe fingerprint for credential identities.
 *
 * `ICredentialContext.identity` holds the inbound credential material —
 * for OIDC/OAuth resolvers that is the raw bearer JWT. Logging the raw
 * value at any level is a confidentiality regression: the bearer is a
 * replayable Graph-OBO assertion and (with log-streaming destinations
 * enabled) it leaves the n8n process boundary in cleartext.
 *
 * `fingerprintIdentity` returns a stable, non-reversible 12-char prefix
 * of `sha256(identity)`. Operators can still correlate log lines for the
 * same identity (same input → same fingerprint), reproduce a fingerprint
 * from a known bearer for support investigations, and distinguish between
 * tokens — without ever surfacing the token itself.
 *
 * Empty/undefined identities yield `undefined` so callers can pass the
 * result straight into a structured log object without producing a
 * misleading "fingerprint of nothing".
 */
export function fingerprintIdentity(value?: string): string | undefined {
	if (!value) return undefined;
	return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
