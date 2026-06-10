import crypto from 'crypto';
import z from 'zod';

export const OAuth2OptionsSchema = z.object({
	metadataUri: z.string().url(),
	subjectClaim: z.string().optional().default('sub'),
	/**
	 * Fork §11 — optional hybrid fallback. When set, on a per-user miss the
	 * resolver returns the decrypted `data` of the credential identified by
	 * this id (a static service-account credential of the same type). Use for
	 * workflows triggered by paths that lack per-user identity (machine
	 * webhooks, anonymous chats). Absence = old behavior (strict per-user;
	 * miss throws). See `Credential-Seeding-Guide.md` for setup guidance.
	 */
	fallbackCredentialId: z.string().trim().min(1).optional(),
});

export type OAuth2Options = z.infer<typeof OAuth2OptionsSchema>;

export function sha256(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}
