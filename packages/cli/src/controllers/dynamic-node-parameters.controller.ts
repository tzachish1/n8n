import {
	OptionsRequestDto,
	ResourceLocatorRequestDto,
	ResourceMapperFieldsRequestDto,
	ActionResultRequestDto,
} from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import { Post, RestController, Body } from '@n8n/decorators';
import { ExecutionContextService } from 'n8n-core';
import type { INodePropertyOptions, NodeParameterValueType } from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';
import { getEditorAdditionalData } from '@/credentials/editor-execution-context';
import { DynamicNodeParametersService } from '@/services/dynamic-node-parameters.service';

@RestController('/dynamic-node-parameters')
export class DynamicNodeParametersController {
	constructor(
		private readonly dynamicNodeParametersService: DynamicNodeParametersService,
		private readonly authService: AuthService,
		private readonly executionContextService: ExecutionContextService,
	) {}

	private async getAdditionalData(
		req: AuthenticatedRequest,
		projectId?: string,
		currentNodeParameters?: OptionsRequestDto['currentNodeParameters'],
	) {
		const additionalData = await getEditorAdditionalData(
			this.authService,
			this.executionContextService,
			req,
			{ projectId, currentNodeParameters },
		);
		if (projectId) {
			additionalData.dataTableProjectId = projectId;
		}
		return additionalData;
	}

	@Post('/options')
	async getOptions(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: OptionsRequestDto,
	): Promise<INodePropertyOptions[]> {
		await this.dynamicNodeParametersService.refineResourceIds(req.user, payload);

		const {
			credentials,
			currentNodeParameters,
			nodeTypeAndVersion,
			path,
			methodName,
			loadOptions,
			projectId,
		} = payload;

		const additionalData = await this.getAdditionalData(req, projectId, currentNodeParameters);

		if (methodName) {
			return await this.dynamicNodeParametersService.getOptionsViaMethodName(
				methodName,
				path,
				additionalData,
				nodeTypeAndVersion,
				currentNodeParameters,
				credentials,
			);
		}

		if (loadOptions) {
			return await this.dynamicNodeParametersService.getOptionsViaLoadOptions(
				loadOptions,
				additionalData,
				nodeTypeAndVersion,
				currentNodeParameters,
				credentials,
			);
		}

		return [];
	}

	@Post('/resource-locator-results')
	async getResourceLocatorResults(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: ResourceLocatorRequestDto,
	) {
		await this.dynamicNodeParametersService.refineResourceIds(req.user, payload);

		const {
			path,
			methodName,
			filter,
			paginationToken,
			credentials,
			currentNodeParameters,
			nodeTypeAndVersion,
			projectId,
		} = payload;

		const additionalData = await this.getAdditionalData(req, projectId, currentNodeParameters);

		return await this.dynamicNodeParametersService.getResourceLocatorResults(
			methodName,
			path,
			additionalData,
			nodeTypeAndVersion,
			currentNodeParameters,
			credentials,
			filter,
			paginationToken,
		);
	}

	@Post('/resource-mapper-fields')
	async getResourceMappingFields(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: ResourceMapperFieldsRequestDto,
	) {
		await this.dynamicNodeParametersService.refineResourceIds(req.user, payload);

		const { path, methodName, credentials, currentNodeParameters, nodeTypeAndVersion, projectId } =
			payload;

		const additionalData = await this.getAdditionalData(req, projectId, currentNodeParameters);

		return await this.dynamicNodeParametersService.getResourceMappingFields(
			methodName,
			path,
			additionalData,
			nodeTypeAndVersion,
			currentNodeParameters,
			credentials,
		);
	}

	@Post('/local-resource-mapper-fields')
	async getLocalResourceMappingFields(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: ResourceMapperFieldsRequestDto,
	) {
		await this.dynamicNodeParametersService.refineResourceIds(req.user, payload);

		const { path, methodName, currentNodeParameters, nodeTypeAndVersion, projectId } = payload;

		const additionalData = await this.getAdditionalData(req, projectId, currentNodeParameters);

		return await this.dynamicNodeParametersService.getLocalResourceMappingFields(
			methodName,
			path,
			additionalData,
			nodeTypeAndVersion,
		);
	}

	@Post('/action-result')
	async getActionResult(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: ActionResultRequestDto,
	): Promise<NodeParameterValueType> {
		await this.dynamicNodeParametersService.refineResourceIds(req.user, payload);

		const {
			currentNodeParameters,
			nodeTypeAndVersion,
			path,
			credentials,
			handler,
			payload: actionPayload,
			projectId,
		} = payload;

		const additionalData = await this.getAdditionalData(req, projectId, currentNodeParameters);

		return await this.dynamicNodeParametersService.getActionResult(
			handler,
			path,
			additionalData,
			nodeTypeAndVersion,
			currentNodeParameters,
			actionPayload,
			credentials,
		);
	}
}
