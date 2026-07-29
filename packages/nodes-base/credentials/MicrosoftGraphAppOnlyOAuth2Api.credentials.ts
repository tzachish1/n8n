import type { ICredentialType, INodeProperties, Icon } from 'n8n-workflow';

/**
 * Fork §10 — Microsoft Graph App-Only credential (client_credentials flow).
 *
 * Companion to the delegated `MicrosoftOAuth2Api` credential. Intended for
 * unattended workflows (schedules, webhooks, system jobs) that should run as
 * the n8n platform identity rather than any specific human owner. n8n's
 * existing `oAuth2Api` helper re-mints access tokens on expiry via the client
 * credentials grant — no refresh token is involved.
 *
 * Permissions are granted on the Entra App Registration as **application**
 * permissions (not delegated) and consented by an Entra admin. The `.default`
 * scope tells Azure to issue a token containing every admin-consented
 * application permission for this app registration.
 *
 * Wireable into HTTP Request nodes day-one. Adding it to the native
 * `microsoft*` node accept-lists (Outlook, Teams, …) is intentionally deferred
 * to a follow-up — see CUSTOMS.md §10.
 */
export class MicrosoftGraphAppOnlyOAuth2Api implements ICredentialType {
	name = 'microsoftGraphAppOnlyOAuth2Api';

	extends = ['oAuth2Api'];

	icon: Icon = 'file:icons/Microsoft.svg';

	displayName = 'Microsoft Graph (App-Only / Client Credentials)';

	documentationUrl = 'microsoft';

	properties: INodeProperties[] = [
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'clientCredentials',
		},
		{
			displayName: 'Tenant ID',
			name: 'tenantId',
			type: 'string',
			default: '',
			required: true,
			description:
				'Your Entra (Azure AD) directory (tenant) ID. App-only tokens are always issued against a specific tenant — `common` is not allowed for client_credentials.',
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'string',
			default: '=https://login.microsoftonline.com/{{$self["tenantId"]}}/oauth2/v2.0/token',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: 'https://graph.microsoft.com/.default',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
		{
			displayName: 'Microsoft Graph API Base URL',
			name: 'graphApiBaseUrl',
			type: 'options',
			options: [
				{ name: 'Global (https://graph.microsoft.com)', value: 'https://graph.microsoft.com' },
				{ name: 'US Government (https://graph.microsoft.us)', value: 'https://graph.microsoft.us' },
				{
					name: 'US Government DOD (https://dod-graph.microsoft.us)',
					value: 'https://dod-graph.microsoft.us',
				},
				{
					name: 'China (https://microsoftgraph.chinacloudapi.cn)',
					value: 'https://microsoftgraph.chinacloudapi.cn',
				},
			],
			default: 'https://graph.microsoft.com',
			description: 'Select the endpoint for your Microsoft cloud environment.',
		},
	];
}
