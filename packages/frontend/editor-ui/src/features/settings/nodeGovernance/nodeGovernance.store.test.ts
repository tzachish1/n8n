import { setActivePinia, createPinia } from 'pinia';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useNodeGovernanceStore } from './nodeGovernance.store';
import type { NodeGovernancePolicy, NodeCategory, NodeAccessRequest } from './nodeGovernance.api';

const {
	getGlobalPolicies,
	getProjectPolicies,
	getCategories,
	getMyRequests,
	getGovernanceSettings,
	getProjectGovernanceSettings,
} = vi.hoisted(() => ({
	getGlobalPolicies: vi.fn(),
	getProjectPolicies: vi.fn(),
	getCategories: vi.fn(),
	getMyRequests: vi.fn(),
	getGovernanceSettings: vi.fn(),
	getProjectGovernanceSettings: vi.fn(),
}));

vi.mock('./nodeGovernance.api', () => ({
	getGlobalPolicies,
	getProjectPolicies,
	getCategories,
	getMyRequests,
	getGovernanceSettings,
	getProjectGovernanceSettings,
}));

vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: vi.fn(() => ({
		restApiContext: { baseUrl: 'http://localhost:5678', sessionId: 'test-session' },
	})),
}));

function buildPolicy(overrides: Partial<NodeGovernancePolicy> = {}): NodeGovernancePolicy {
	return {
		id: 'policy-id',
		policyType: 'allow',
		scope: 'global',
		targetType: 'node',
		targetValue: 'n8n-nodes-base.httpRequest',
		createdById: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function buildCategory(overrides: Partial<NodeCategory> = {}): NodeCategory {
	return {
		id: 'category-id',
		slug: 'ai',
		displayName: 'AI',
		description: null,
		color: null,
		createdById: null,
		nodeAssignments: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function buildRequest(overrides: Partial<NodeAccessRequest> = {}): NodeAccessRequest {
	return {
		id: 'request-id',
		projectId: 'project-1',
		requestedById: 'user-1',
		nodeType: 'n8n-nodes-base.httpRequest',
		justification: 'need it',
		workflowName: null,
		status: 'pending',
		reviewedById: null,
		reviewComment: null,
		reviewedAt: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

const AI_SUB_NODE = '@n8n/n8n-nodes-langchain.lmChatOpenAi';
const PROJECT_ID = 'project-1';

describe('useNodeGovernanceStore', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();

		getGlobalPolicies.mockResolvedValue({ policies: [] });
		getProjectPolicies.mockResolvedValue({ policies: [] });
		getCategories.mockResolvedValue({ categories: [] });
		getMyRequests.mockResolvedValue({ requests: [] });
		getGovernanceSettings.mockResolvedValue({
			globalDefault: 'allow',
			projectOverrides: [],
		});
		getProjectGovernanceSettings.mockResolvedValue({
			defaultBehavior: null,
			projectId: PROJECT_ID,
			projectName: 'Test Project',
		});
	});

	describe('resolveGovernanceForNode', () => {
		it('returns allowed before governance data has loaded (fail-open at boot)', () => {
			const store = useNodeGovernanceStore();
			expect(store.resolveGovernanceForNode(AI_SUB_NODE).status).toBe('allowed');
		});

		it('blocks an un-policied node when the global default is block', async () => {
			getGovernanceSettings.mockResolvedValue({
				globalDefault: 'block',
				projectOverrides: [],
			});

			const store = useNodeGovernanceStore();
			await store.fetchGovernanceData(PROJECT_ID);

			expect(store.resolveGovernanceForNode(AI_SUB_NODE).status).toBe('blocked');
		});

		it('allows an un-policied node when the global default is allow', async () => {
			const store = useNodeGovernanceStore();
			await store.fetchGovernanceData(PROJECT_ID);

			expect(store.resolveGovernanceForNode('n8n-nodes-base.httpRequest').status).toBe('allowed');
		});

		it('honours a project-level allow override over a global block default', async () => {
			getGovernanceSettings.mockResolvedValue({
				globalDefault: 'block',
				projectOverrides: [
					{ projectId: PROJECT_ID, projectName: 'Test', defaultBehavior: 'allow' },
				],
			});
			getProjectGovernanceSettings.mockResolvedValue({
				defaultBehavior: 'allow',
				projectId: PROJECT_ID,
				projectName: 'Test Project',
			});

			const store = useNodeGovernanceStore();
			await store.fetchGovernanceData(PROJECT_ID);

			expect(store.resolveGovernanceForNode(AI_SUB_NODE).status).toBe('allowed');
		});

		it('honours a project-level block override over a global allow default', async () => {
			getProjectGovernanceSettings.mockResolvedValue({
				defaultBehavior: 'block',
				projectId: PROJECT_ID,
				projectName: 'Test Project',
			});

			const store = useNodeGovernanceStore();
			await store.fetchGovernanceData(PROJECT_ID);

			expect(store.resolveGovernanceForNode(AI_SUB_NODE).status).toBe('blocked');
		});

		it('honours a global block policy on a specific node even when default is allow', async () => {
			getGlobalPolicies.mockResolvedValue({
				policies: [
					buildPolicy({
						policyType: 'block',
						targetType: 'node',
						targetValue: AI_SUB_NODE,
					}),
				],
			});

			const store = useNodeGovernanceStore();
			await store.fetchGovernanceData(PROJECT_ID);

			expect(store.resolveGovernanceForNode(AI_SUB_NODE).status).toBe('blocked');
		});

		it('honours a category-targeted block policy via the assigned category', async () => {
			getGlobalPolicies.mockResolvedValue({
				policies: [
					buildPolicy({
						policyType: 'block',
						targetType: 'category',
						targetValue: 'ai',
					}),
				],
			});
			getCategories.mockResolvedValue({
				categories: [
					buildCategory({
						slug: 'ai',
						nodeAssignments: [{ id: 'a1', nodeType: AI_SUB_NODE }],
					}),
				],
			});

			const store = useNodeGovernanceStore();
			await store.fetchGovernanceData(PROJECT_ID);

			expect(store.resolveGovernanceForNode(AI_SUB_NODE).status).toBe('blocked');
		});

		it('lets a project-scoped allow policy beat a global block policy on the same node (priority 1 > 2)', async () => {
			getGlobalPolicies.mockResolvedValue({
				policies: [
					buildPolicy({
						id: 'global-block',
						policyType: 'block',
						scope: 'global',
						targetType: 'node',
						targetValue: AI_SUB_NODE,
					}),
				],
			});
			getProjectPolicies.mockResolvedValue({
				policies: [
					buildPolicy({
						id: 'project-allow',
						policyType: 'allow',
						scope: 'projects',
						targetType: 'node',
						targetValue: AI_SUB_NODE,
						projectAssignments: [{ id: 'pa1', projectId: PROJECT_ID }],
					}),
				],
			});

			const store = useNodeGovernanceStore();
			await store.fetchGovernanceData(PROJECT_ID);

			expect(store.resolveGovernanceForNode(AI_SUB_NODE).status).toBe('allowed');
		});

		it('upgrades a blocked status to pending_request when the user has an open access request', async () => {
			getGovernanceSettings.mockResolvedValue({
				globalDefault: 'block',
				projectOverrides: [],
			});
			getMyRequests.mockResolvedValue({
				requests: [
					buildRequest({
						nodeType: AI_SUB_NODE,
						projectId: PROJECT_ID,
						status: 'pending',
					}),
				],
			});

			const store = useNodeGovernanceStore();
			await store.fetchGovernanceData(PROJECT_ID);

			const status = store.resolveGovernanceForNode(AI_SUB_NODE);
			expect(status.status).toBe('pending_request');
			expect(status.requestId).toBe('request-id');
		});
	});
});
