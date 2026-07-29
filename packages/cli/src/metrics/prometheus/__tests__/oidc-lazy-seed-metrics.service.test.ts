import type { Mock } from 'vitest';
import { mockInstance } from '@n8n/backend-test-utils';
import { PrometheusMetricsConfig } from '@n8n/config';
import { mock } from 'vitest-mock-extended';
import promClient from 'prom-client';

import { PrometheusOidcLazySeedMetricsService } from '../oidc-lazy-seed-metrics.service';

import type { EventService } from '@/events/event.service';

vi.mock('prom-client');

describe('PrometheusOidcLazySeedMetricsService', () => {
	const config = mockInstance(PrometheusMetricsConfig, {
		prefix: 'n8n_',
	});
	const eventService = mock<EventService>();
	let service: PrometheusOidcLazySeedMetricsService;
	let mockCounterInc: Mock;

	function getEventHandler(eventName: string) {
		return eventService.on.mock.calls.find((c) => c[0] === eventName)?.[1];
	}

	beforeEach(() => {
		Object.assign(config, { prefix: 'n8n_' });
		service = new PrometheusOidcLazySeedMetricsService(config, eventService);
		mockCounterInc = vi.fn();
		promClient.Counter.prototype.inc = mockCounterInc;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('enabled', () => {
		it('should always be true', () => {
			expect(service.enabled).toBe(true);
		});
	});

	describe('init', () => {
		it('should register oidc_lazy_seed_attempts_total counter', () => {
			service.init();

			expect(promClient.Counter).toHaveBeenCalledWith({
				name: 'n8n_oidc_lazy_seed_attempts_total',
				help: 'Total number of OIDC webhook lazy-seed attempts, labelled by outcome.',
				labelNames: ['result', 'reason'],
			});
		});

		it('should pre-seed seeded/success at 0', () => {
			service.init();

			expect(mockCounterInc).toHaveBeenCalledWith({ result: 'seeded', reason: 'success' }, 0);
		});

		it('should increment on oidc-graph-token-lazy-seeded', () => {
			service.init();
			const handler = getEventHandler('oidc-graph-token-lazy-seeded');
			vi.clearAllMocks();

			expect(handler).toBeDefined();
			handler!({});

			expect(mockCounterInc).toHaveBeenCalledWith({ result: 'seeded', reason: 'success' }, 1);
		});

		it('should increment on oidc-graph-token-lazy-seed-skipped', () => {
			service.init();
			const handler = getEventHandler('oidc-graph-token-lazy-seed-skipped');
			vi.clearAllMocks();

			expect(handler).toBeDefined();
			handler!({ reason: 'disabled' });

			expect(mockCounterInc).toHaveBeenCalledWith({ result: 'skipped', reason: 'disabled' }, 1);
		});

		it('should increment on oidc-graph-token-lazy-seed-failed', () => {
			service.init();
			const handler = getEventHandler('oidc-graph-token-lazy-seed-failed');
			vi.clearAllMocks();

			expect(handler).toBeDefined();
			handler!({});

			expect(mockCounterInc).toHaveBeenCalledWith(
				{ result: 'failed', reason: 'obo_or_persist_error' },
				1,
			);
		});
	});
});
