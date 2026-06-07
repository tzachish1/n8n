import { Logger } from '@n8n/backend-common';
import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

@BackendModule({ name: 'sso-oidc', licenseFlag: 'feat:oidc', instanceTypes: ['main'] })
export class OidcModule implements ModuleInterface {
	async init() {
		await import('./oidc.controller.ee');

		const { OidcService } = await import('./oidc.service.ee');
		await Container.get(OidcService).init();

		// Fork §10 Phase 2 — register the webhook lazy-seed provider with the
		// dynamic-credentials module so resolver misses can be recovered via OBO.
		// Guarded on the dynamic-credentials feature flag because the module is
		// the only consumer of `DynamicCredentialService.setLazySeedProvider` —
		// without it, the import would fail (missing entities) and there would
		// be nothing to register against anyway.
		if (process.env.N8N_ENV_FEAT_DYNAMIC_CREDENTIALS === 'true') {
			try {
				const { OidcWebhookSeederService } = await import('./services/oidc-webhook-seeder.service');
				const { DynamicCredentialService } = await import(
					'../dynamic-credentials.ee/services/dynamic-credential.service'
				);
				Container.get(DynamicCredentialService).setLazySeedProvider(
					Container.get(OidcWebhookSeederService),
				);
			} catch (error) {
				Container.get(Logger).warn(
					'OIDC lazy-seed: failed to register webhook seeder; resolver misses will surface as upstream',
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
		}
	}
}
