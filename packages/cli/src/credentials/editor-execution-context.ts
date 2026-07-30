import type { AuthenticatedRequest } from '@n8n/db';
import type { Request } from 'express';
import type { ExecutionContextService } from 'n8n-core';
import type { INodeParameters, IWorkflowExecuteAdditionalData } from 'n8n-workflow';

import type { AuthService } from '@/auth/auth.service';
import { getBase } from '@/workflow-execute-additional-data';

/**
 * Builds additional data for editor-driven node parameter requests (load options,
 * resource locators, etc.) with an execution context that carries the current
 * user's n8n session. Required so resolvable credentials can load per-user OAuth
 * tokens stored via Connect (system resolver) while running in `internal` mode.
 */
export async function getEditorAdditionalData(
	authService: AuthService,
	executionContextService: ExecutionContextService,
	req: AuthenticatedRequest,
	{
		projectId,
		currentNodeParameters,
	}: {
		projectId?: string;
		currentNodeParameters?: INodeParameters;
	},
): Promise<IWorkflowExecuteAdditionalData> {
	const additionalData = await getBase({
		userId: req.user.id,
		projectId,
		currentNodeParameters,
	});

	const n8nAuthCookie = authService.getCookieToken(req as unknown as Request);
	if (n8nAuthCookie) {
		additionalData.executionContext = {
			version: 1,
			establishedAt: Date.now(),
			source: 'internal',
			credentials: await executionContextService.buildManualExecutionCredentials(n8nAuthCookie),
		};
	}

	return additionalData;
}
