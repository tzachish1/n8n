import { mockInstance } from '@n8n/backend-test-utils';
import { PrometheusMetricsConfig } from '@n8n/config';
import { mock } from 'vitest-mock-extended';
import promClient from 'prom-client';

import { EventMessageWorkflow } from '@/eventbus/event-message-classes/event-message-workflow';
import { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { PrometheusEventBusMetricsService } from '../event-bus-metrics.service';

vi.unmock('@/eventbus/message-event-bus/message-event-bus');

describe('PrometheusEventBusMetricsService (unmocked)', () => {
	const eventBus = new MessageEventBus(mock(), mock(), mock(), mock(), mock(), mock());

	beforeEach(() => {
		promClient.register.clear();
	});

	afterEach(() => {
		promClient.register.clear();
	});

	test('support workflow id labels', () => {
		const config = mockInstance(PrometheusMetricsConfig, {
			prefix: '',
			includeMessageEventBusMetrics: true,
			includeWorkflowIdLabel: true,
			includeWorkflowNameLabel: false,
			includeExecutionModeLabel: false,
			includeProjectIdLabel: true,
		});

		const service = new PrometheusEventBusMetricsService(eventBus, config);
		service.init();

		const event = new EventMessageWorkflow({
			eventName: 'n8n.workflow.success',
			payload: { workflowId: '1234' },
		});

		eventBus.emit('metrics.eventBus.event', event);

		const counter = promClient.register.getSingleMetric('workflow_success_total');
		expect(counter).toBeDefined();
	});

	test('falls back to remembered project_id when payload omits it', () => {
		const config = mockInstance(PrometheusMetricsConfig, {
			prefix: '',
			includeMessageEventBusMetrics: true,
			includeWorkflowIdLabel: true,
			includeWorkflowNameLabel: false,
			includeExecutionModeLabel: false,
			includeProjectIdLabel: true,
		});

		const service = new PrometheusEventBusMetricsService(eventBus, config);
		service.init();

		eventBus.emit(
			'metrics.eventBus.event',
			new EventMessageWorkflow({
				eventName: 'n8n.workflow.success',
				payload: { workflowId: '1234', projectId: 'proj-abc' },
			}),
		);
		eventBus.emit(
			'metrics.eventBus.event',
			new EventMessageWorkflow({
				eventName: 'n8n.workflow.success',
				payload: { workflowId: '1234' },
			}),
		);

		const counter = promClient.register.getSingleMetric('workflow_success_total');
		expect(counter).toBeDefined();
	});
});
