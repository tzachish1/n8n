import { MicrosoftGraphAppOnlyOAuth2Api } from '../MicrosoftGraphAppOnlyOAuth2Api.credentials';

describe('MicrosoftGraphAppOnlyOAuth2Api Credential', () => {
	const credential = new MicrosoftGraphAppOnlyOAuth2Api();

	const propByName = (name: string) => credential.properties.find((p) => p.name === name);

	it('has the expected identity and inherits from oAuth2Api', () => {
		expect(credential.name).toBe('microsoftGraphAppOnlyOAuth2Api');
		expect(credential.extends).toEqual(['oAuth2Api']);
		expect(credential.displayName).toContain('Microsoft Graph');
	});

	it('uses the client_credentials grant', () => {
		const grantType = propByName('grantType');
		expect(grantType).toBeDefined();
		expect(grantType?.type).toBe('hidden');
		expect(grantType?.default).toBe('clientCredentials');
	});

	it('defaults the scope to /.default so admin-consented app permissions are returned', () => {
		const scope = propByName('scope');
		expect(scope).toBeDefined();
		expect(scope?.type).toBe('hidden');
		expect(scope?.default).toBe('https://graph.microsoft.com/.default');
	});

	it('templates the access token URL with the tenant id', () => {
		const accessTokenUrl = propByName('accessTokenUrl');
		expect(accessTokenUrl).toBeDefined();
		expect(accessTokenUrl?.default).toBe(
			'=https://login.microsoftonline.com/{{$self["tenantId"]}}/oauth2/v2.0/token',
		);
	});

	it('requires the tenant id (client_credentials cannot use /common)', () => {
		const tenantId = propByName('tenantId');
		expect(tenantId).toBeDefined();
		expect(tenantId?.required).toBe(true);
		expect(tenantId?.type).toBe('string');
	});

	it('exposes a Graph base URL selector with the four national clouds', () => {
		const graphApiBaseUrl = propByName('graphApiBaseUrl');
		expect(graphApiBaseUrl).toBeDefined();
		expect(graphApiBaseUrl?.type).toBe('options');
		expect(graphApiBaseUrl?.default).toBe('https://graph.microsoft.com');
		const optionValues = (graphApiBaseUrl?.options as Array<{ name: string; value: string }>).map(
			(o) => o.value,
		);
		expect(optionValues).toEqual(
			expect.arrayContaining([
				'https://graph.microsoft.com',
				'https://graph.microsoft.us',
				'https://dod-graph.microsoft.us',
				'https://microsoftgraph.chinacloudapi.cn',
			]),
		);
	});

	it('puts credentials in the request body (Entra rejects basic auth for client_credentials)', () => {
		const authentication = propByName('authentication');
		expect(authentication?.type).toBe('hidden');
		expect(authentication?.default).toBe('body');
	});
});
