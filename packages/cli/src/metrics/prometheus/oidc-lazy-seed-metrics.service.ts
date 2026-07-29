import { PrometheusMetricsConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import promClient from 'prom-client';

import { EventService } from '@/events/event.service';

import type { PrometheusMetricsCollector } from './base';

/**
 * Fork §10 Phase 2 — webhook lazy-seed counter.
 *
 * `n8n_oidc_lazy_seed_attempts_total{result, reason}` increments once per
 * `OidcWebhookSeederService.tryLazySeed` outcome. `result` is `seeded`,
 * `skipped`, or `failed`; `reason` carries the structured skip/fail code
 * (or `success` when the seed completed).
 */
@Service()
export class PrometheusOidcLazySeedMetricsService implements PrometheusMetricsCollector {
	constructor(
		private readonly config: PrometheusMetricsConfig,
		private readonly eventService: EventService,
	) {}

	get enabled(): boolean {
		return true;
	}

	init() {
		const oidcLazySeedAttemptsTotal = new promClient.Counter({
			name: `${this.config.prefix}oidc_lazy_seed_attempts_total`,
			help: 'Total number of OIDC webhook lazy-seed attempts, labelled by outcome.',
			labelNames: ['result', 'reason'],
		});
		oidcLazySeedAttemptsTotal.inc({ result: 'seeded', reason: 'success' }, 0);

		this.eventService.on('oidc-graph-token-lazy-seeded', () => {
			oidcLazySeedAttemptsTotal.inc({ result: 'seeded', reason: 'success' }, 1);
		});

		this.eventService.on('oidc-graph-token-lazy-seed-skipped', ({ reason }) => {
			oidcLazySeedAttemptsTotal.inc({ result: 'skipped', reason }, 1);
		});

		this.eventService.on('oidc-graph-token-lazy-seed-failed', () => {
			oidcLazySeedAttemptsTotal.inc({ result: 'failed', reason: 'obo_or_persist_error' }, 1);
		});
	}
}
