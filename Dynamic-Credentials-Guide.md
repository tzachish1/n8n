# n8n Dynamic Credentials -- Setup & Usage Guide

Dynamic Credentials is an Enterprise Edition feature in n8n that enables **per-user credential resolution at runtime**. Instead of every workflow execution using a single fixed credential (the workflow owner's), each execution uses the **triggering user's own credentials** -- resolved automatically from their identity token.

This is ideal for scenarios where workflows are triggered via webhooks or forms, and downstream nodes (e.g., Jira, Confluence, Slack, Google) should operate as the user who triggered the workflow, not as a shared service account.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Part 1: Admin Setup](#part-1-admin-setup)
  - [Step 1: Enable the Feature](#step-1-enable-the-feature)
  - [Step 2: Create a Credential Resolver](#step-2-create-a-credential-resolver)
  - [Step 3: Mark Credentials as Dynamic](#step-3-mark-credentials-as-dynamic)
  - [Step 4: Configure the Webhook Trigger](#step-4-configure-the-webhook-trigger)
  - [Step 5: Assign the Resolver to the Workflow](#step-5-assign-the-resolver-to-the-workflow)
- [Part 2: End-User OAuth Authorization Flow](#part-2-end-user-oauth-authorization-flow)
  - [Step 1: Initiate OAuth Authorization](#step-1-initiate-oauth-authorization)
  - [Step 2: User Completes OAuth Consent](#step-2-user-completes-oauth-consent)
  - [Step 3: Trigger the Workflow](#step-3-trigger-the-workflow)
  - [Revoking a User's Credentials](#revoking-a-users-credentials)
- [Part 3: Atlassian (Jira/Confluence) Example](#part-3-atlassian-jiraconfluence-example)
- [Architecture Overview](#architecture-overview)
- [Environment Variables Reference](#environment-variables-reference)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## How It Works

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Dynamic Credentials Flow                           │
│                                                                             │
│  1. User calls webhook with Bearer token (e.g., their OAuth access token)  │
│                              │                                              │
│                              ▼                                              │
│  2. Webhook trigger extracts identity from Authorization header             │
│     (via Bearer Token Extractor hook)                                       │
│                              │                                              │
│                              ▼                                              │
│  3. Identity is encrypted and stored in the execution context               │
│     → flows through the entire workflow execution                           │
│                              │                                              │
│                              ▼                                              │
│  4. When a node needs credentials, the system checks:                       │
│     Is this credential marked as "resolvable"?                              │
│           │                           │                                     │
│          YES                          NO                                    │
│           │                           │                                     │
│           ▼                           ▼                                     │
│  5a. Resolver introspects        5b. Uses static                            │
│      the Bearer token via            credentials                            │
│      the IdP (e.g., Atlassian)       as usual                               │
│           │                                                                 │
│           ▼                                                                 │
│  6. Subject ID extracted (e.g., user email)                                 │
│           │                                                                 │
│           ▼                                                                 │
│  7. Per-user OAuth tokens looked up from storage                            │
│           │                                                                 │
│           ▼                                                                 │
│  8. Node executes as that specific user                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- n8n instance (self-hosted)
- Enterprise license with `feat:dynamicCredentials` enabled (or license check bypassed in fork)
- An OAuth2/OpenID Connect Identity Provider (e.g., Atlassian, Okta, Azure AD, Keycloak)
- An OAuth2 application registered with your IdP

---

## Part 1: Admin Setup

### Step 1: Enable the Feature

Set the following environment variables on your n8n instance:

```bash
# Required: enables the Dynamic Credentials module
N8N_ENV_FEAT_DYNAMIC_CREDENTIALS=true

# Optional: authentication token for the external dynamic credentials API endpoints
# (authorize/revoke). Required if external apps will call these endpoints.
N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN=your-secret-token-here

# Optional: CORS origins for external apps calling the authorize/revoke endpoints
N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN=https://your-app.example.com

# Optional: allow credentials in CORS requests (must be false if using wildcard origin)
N8N_DYNAMIC_CREDENTIALS_CORS_ALLOW_CREDENTIALS=false
```

Restart n8n after setting these variables.

**License check (fork only):** If your fork doesn't have an enterprise license with `feat:dynamicCredentials`, you may need to modify `LicenseState.isDynamicCredentialsLicensed()` in `packages/@n8n/backend-common/src/license-state.ts` to return `true`.

### Step 2: Create a Credential Resolver

A **Credential Resolver** tells n8n how to validate incoming identity tokens and map them to user-specific credentials.

#### Via the UI

1. Go to **Settings** > **Credential Resolvers** (this menu item appears once the feature is enabled)
2. Click **Create Resolver**
3. Fill in:
   - **Name**: A descriptive name (e.g., "Atlassian OAuth2 Resolver")
   - **Type**: OAuth2 Resolver
   - **Metadata URL**: Your IdP's OpenID Connect discovery endpoint
     - Atlassian: `https://auth.atlassian.com/.well-known/openid-configuration`
     - Okta: `https://your-org.okta.com/.well-known/openid-configuration`
     - Azure AD: `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`
     - Keycloak: `https://your-keycloak/realms/{realm}/.well-known/openid-configuration`
   - **Validation Method**: Choose one of:
     - **OAuth2 Token Introspection** -- validates the token via the IdP's introspection endpoint (requires client ID/secret)
     - **OAuth2 UserInfo Endpoint** -- validates the token by calling the IdP's userinfo endpoint (no client credentials needed)
   - **Client ID** / **Client Secret** (introspection only): Your OAuth2 app's credentials
   - **Subject Claim**: The token claim to use as the user identifier (default: `sub`)
4. Click **Save**

#### Via the API

```bash
curl -X POST https://your-n8n.example.com/api/v1/credential-resolvers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <n8n-api-key>" \
  -d '{
    "name": "Atlassian OAuth2 Resolver",
    "type": "credential-resolver.oauth2-1.0",
    "config": {
      "metadataUri": "https://auth.atlassian.com/.well-known/openid-configuration",
      "validation": "oauth2-userinfo",
      "subjectClaim": "sub"
    }
  }'
```

The response will include the resolver's `id` -- save this for the next steps.

### Step 3: Mark Credentials as Dynamic

For each credential that should use per-user resolution (e.g., your Jira OAuth2 credential):

#### Via the UI

1. Go to **Credentials** and open the credential you want to make dynamic
2. At the bottom of the credential form, find the **"Set up for dynamic credentials"** toggle
   > Note: This toggle only appears for OAuth-type credentials (OAuth1/OAuth2).
3. Enable the toggle
4. Save the credential

When enabled, you'll see a **"Dynamic"** badge on the credential card in the credentials list.

**What this means:** The static credential data you configure here is used as a **fallback** (for manual testing or non-webhook triggers). During webhook-triggered executions, the system will resolve user-specific credentials instead.

### Step 4: Configure the Webhook Trigger

On your webhook (or form) trigger node, you need to configure how n8n extracts the user's identity:

1. Open the **Webhook** trigger node settings
2. Find the **"Identify user for dynamic credentials"** section
3. Click **"Add User Identifier"**
4. Select the extraction method:
   - **Bearer Token Extractor** -- extracts the token from `Authorization: Bearer <token>` header (most common)
   - **HTTP Header Extractor** -- extracts identity from any custom header using a regex pattern
     - **Header Name**: The HTTP header name (default: `authorization`)
     - **Header Value Pattern**: A regex with a capture group for the identity value (default: `[Bb][Ee][Aa][Rr][Ee][Rr]\s+(.+)`)

When configured, you'll see a dynamic credentials icon on the webhook node in the canvas.

**Important:** The extracted identity value (e.g., the Bearer token) is automatically **masked** (`**********`) in the webhook output data for security -- downstream nodes won't see the raw token in `$json.headers.authorization`.

### Step 5: Assign the Resolver to the Workflow

1. Open **Workflow Settings** (gear icon in the workflow editor)
2. Find the **"Credential Resolver"** dropdown
3. Select the resolver you created in Step 2
4. Save the workflow settings

This tells n8n which resolver to use for all dynamic credentials in this workflow. You can also assign a resolver directly to individual credentials if different credentials need different resolvers.

---

## Part 2: End-User OAuth Authorization Flow

Before a user can trigger workflows with dynamic credentials, they need to **authorize** their account. This is a one-time OAuth consent flow per user per credential.

### Step 1: Initiate OAuth Authorization

Your application (or the user) calls the n8n authorize endpoint:

```bash
curl -X POST https://your-n8n.example.com/api/v1/credentials/{credentialId}/authorize?resolverId={resolverId} \
  -H "Authorization: Bearer <user-identity-token>" \
  -H "x-authorization: <endpoint-auth-token>"
```

Where:
- `{credentialId}` -- the ID of the dynamic credential
- `{resolverId}` -- the ID of the credential resolver
- `Authorization: Bearer <token>` -- the user's identity token (will be validated by the resolver)
- `x-authorization` -- the static endpoint auth token (from `N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN`)

**Response:** An OAuth authorization URL. Redirect the user to this URL.

### Step 2: User Completes OAuth Consent

The user is redirected to the IdP (e.g., Atlassian) to:
1. Log in (if not already)
2. Grant consent for the n8n OAuth app to access their resources
3. Get redirected back to n8n's OAuth callback

n8n stores the user's OAuth tokens (access token, refresh token) **encrypted in the database**, keyed by `(credentialId, subjectId, resolverId)`.

### Step 3: Trigger the Workflow

Now when the user calls the webhook, their identity is automatically resolved:

```bash
curl -X POST https://your-n8n.example.com/webhook/your-webhook-path \
  -H "Authorization: Bearer <user-identity-token>" \
  -H "Content-Type: application/json" \
  -d '{"action": "create-issue", "project": "PROJ", "summary": "Bug report"}'
```

The workflow executes, and the Jira node creates the issue **as that specific user**, using their stored OAuth tokens.

### Revoking a User's Credentials

To revoke a user's stored credentials:

```bash
curl -X DELETE https://your-n8n.example.com/api/v1/credentials/{credentialId}/revoke?resolverId={resolverId} \
  -H "Authorization: Bearer <user-identity-token>" \
  -H "x-authorization: <endpoint-auth-token>"
```

This removes the user's per-subject credential data from the database.

---

## Part 3: Atlassian (Jira/Confluence) Example

Here's a concrete example for setting up dynamic credentials with Atlassian.

### 1. Register an OAuth2 App with Atlassian

1. Go to [developer.atlassian.com](https://developer.atlassian.com/console/myapps/)
2. Create a new OAuth 2.0 app
3. Configure the callback URL: `https://your-n8n.example.com/rest/oauth2-credential/callback`
4. Add the required scopes (e.g., `read:jira-work`, `write:jira-work`, `read:confluence-content.all`)
5. Note the **Client ID** and **Client Secret**

### 2. Create the Credential Resolver

Via Settings > Credential Resolvers:

| Field | Value |
|-------|-------|
| Name | Atlassian Resolver |
| Type | OAuth2 Resolver |
| Metadata URL | `https://auth.atlassian.com/.well-known/openid-configuration` |
| Validation | OAuth2 UserInfo Endpoint |
| Subject Claim | `sub` (or `email` if you prefer) |

### 3. Create a Jira OAuth2 Credential

1. Create a new **Jira Software Cloud** credential
2. Enter the Client ID and Client Secret from your Atlassian app
3. Complete the initial OAuth setup (this authorizes the workflow owner -- used as fallback)
4. Enable **"Set up for dynamic credentials"**
5. Save

### 4. Build the Workflow

1. **Webhook trigger** -- configure with Bearer Token Extractor
2. **Jira node** -- select the dynamic credential; configure it to create/update/query issues
3. In **Workflow Settings**, assign the Atlassian Resolver

### 5. User Authorization

Each user who needs to use the workflow:
1. Calls `POST /credentials/{id}/authorize?resolverId={id}` with their identity token
2. Completes the Atlassian OAuth consent
3. Their Atlassian tokens are stored for future executions

### 6. Runtime Execution

```bash
curl -X POST https://your-n8n.example.com/webhook/jira-automation \
  -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..." \
  -H "Content-Type: application/json" \
  -d '{"action": "create", "project": "MYPROJ", "summary": "Task from user"}'
```

The Jira node creates the issue as the authenticated user.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Component Architecture                             │
│                                                                             │
│  ┌──────────────┐    ┌────────────────────┐    ┌──────────────────────┐     │
│  │   Webhook    │───▶│  Context           │───▶│  Execution Context   │     │
│  │   Trigger    │    │  Establishment     │    │  (encrypted runtime  │     │
│  │              │    │  Hooks             │    │   data)              │     │
│  └──────────────┘    │  ┌───────────────┐ │    └──────────┬───────────┘     │
│                      │  │Bearer Token   │ │               │                 │
│                      │  │Extractor      │ │               │                 │
│                      │  └───────────────┘ │               │                 │
│                      │  ┌───────────────┐ │               │                 │
│                      │  │HTTP Header    │ │               │                 │
│                      │  │Extractor      │ │               │                 │
│                      │  └───────────────┘ │               │                 │
│                      └────────────────────┘               │                 │
│                                                           ▼                 │
│  ┌──────────────┐    ┌────────────────────┐    ┌──────────────────────┐     │
│  │  Downstream  │───▶│  Credentials       │───▶│  Dynamic Credential  │     │
│  │  Node (Jira) │    │  Helper            │    │  Service             │     │
│  │              │    │  getDecrypted()    │    │  resolveIfNeeded()   │     │
│  └──────────────┘    └────────────────────┘    └──────────┬───────────┘     │
│                                                           │                 │
│                                                           ▼                 │
│                                                ┌──────────────────────┐     │
│                                                │  Credential Resolver │     │
│                                                │  (OAuth2)            │     │
│                                                │  ┌────────────────┐  │     │
│                                                │  │ Introspection  │  │     │
│                                                │  │ or UserInfo    │  │     │
│                                                │  └───────┬────────┘  │     │
│                                                │          │           │     │
│                                                │          ▼           │     │
│                                                │  ┌────────────────┐  │     │
│                                                │  │ Per-Subject    │  │     │
│                                                │  │ Credential     │  │     │
│                                                │  │ Storage (DB)   │  │     │
│                                                │  └────────────────┘  │     │
│                                                └──────────────────────┘     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Database Tables

| Table | Purpose |
|-------|---------|
| `credential_resolver` | Stores resolver configurations (type, metadata URL, client credentials) |
| `dynamic_credential_entry` | Per-subject OAuth credential data (keyed by credentialId + subjectId + resolverId) |
| `dynamic_credential_user_entry` | Per-n8n-user credential data (for the n8n JWT resolver -- not active by default) |

### Key Source Files

| File | Purpose |
|------|---------|
| `packages/cli/src/modules/dynamic-credentials.ee/dynamic-credentials.module.ts` | Module entry point, feature flag check |
| `packages/cli/src/modules/dynamic-credentials.ee/services/dynamic-credential.service.ts` | Core resolution logic |
| `packages/cli/src/modules/dynamic-credentials.ee/credential-resolvers/oauth-credential-resolver.ts` | OAuth2 resolver implementation |
| `packages/cli/src/modules/dynamic-credentials.ee/context-establishment-hooks/bearer-token-extractor.ts` | Bearer token identity extraction |
| `packages/cli/src/modules/dynamic-credentials.ee/context-establishment-hooks/http-header-extractor.ts` | Generic HTTP header identity extraction |
| `packages/cli/src/modules/dynamic-credentials.ee/dynamic-credentials.controller.ts` | OAuth authorize/revoke API endpoints |
| `packages/cli/src/modules/dynamic-credentials.ee/credential-resolvers.controller.ts` | Resolver CRUD API endpoints |
| `packages/core/src/execution-engine/execution-context.service.ts` | Execution context augmentation with hooks |
| `packages/workflow/src/execution-context.ts` | Execution context and credential context types |
| `packages/cli/src/credentials-helper.ts` | Credential decryption with dynamic resolution |

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `N8N_ENV_FEAT_DYNAMIC_CREDENTIALS` | Yes | `false` | Set to `true` to enable the Dynamic Credentials module |
| `N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN` | Recommended | (empty) | Static auth token for the external authorize/revoke API endpoints. When empty, only authenticated n8n users can access these endpoints. |
| `N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN` | No | (empty) | Comma-separated CORS origins for the authorize/revoke endpoints. When empty, CORS is disabled. Example: `https://app.example.com,https://admin.example.com` |
| `N8N_DYNAMIC_CREDENTIALS_CORS_ALLOW_CREDENTIALS` | No | `false` | Whether to allow credentials (cookies, auth headers) in CORS requests. Must be `false` when using wildcard (`*`) origin. |

---

## API Reference

### Credential Resolvers

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/api/v1/credential-resolvers` | `credentialResolver:list` | List all resolvers |
| `GET` | `/api/v1/credential-resolvers/types` | `credentialResolver:list` | List available resolver types |
| `POST` | `/api/v1/credential-resolvers` | `credentialResolver:create` | Create a new resolver |
| `GET` | `/api/v1/credential-resolvers/:id` | `credentialResolver:read` | Get a specific resolver |
| `PATCH` | `/api/v1/credential-resolvers/:id` | `credentialResolver:update` | Update a resolver |
| `DELETE` | `/api/v1/credential-resolvers/:id` | `credentialResolver:delete` | Delete a resolver |

### Dynamic Credential Endpoints (External)

These endpoints are authenticated via the `x-authorization` header (using the `N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN`), or via standard n8n user authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/credentials/:id/authorize?resolverId=<id>` | Initiates OAuth flow for a user. Send user's Bearer token in `Authorization` header. Returns an OAuth authorization URL. |
| `DELETE` | `/api/v1/credentials/:id/revoke?resolverId=<id>` | Revokes a user's stored credentials. Send user's Bearer token in `Authorization` header. |

### Create Resolver Request Body

```json
{
  "name": "My OAuth2 Resolver",
  "type": "credential-resolver.oauth2-1.0",
  "config": {
    "metadataUri": "https://auth.example.com/.well-known/openid-configuration",
    "validation": "oauth2-introspection",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "subjectClaim": "sub"
  }
}
```

For UserInfo validation (no client credentials needed):

```json
{
  "name": "My OAuth2 Resolver",
  "type": "credential-resolver.oauth2-1.0",
  "config": {
    "metadataUri": "https://auth.example.com/.well-known/openid-configuration",
    "validation": "oauth2-userinfo",
    "subjectClaim": "sub"
  }
}
```

---

## Troubleshooting

### Feature not appearing in UI

- Verify `N8N_ENV_FEAT_DYNAMIC_CREDENTIALS=true` is set
- Verify the license includes `feat:dynamicCredentials`
- Restart n8n after changing environment variables
- Check that the `dynamic-credentials` module appears in active modules (Settings > General)

### "Dynamic credentials are enabled, but no resolver is selected"

- Go to Workflow Settings and select a Credential Resolver from the dropdown
- Or assign a resolver directly to the credential

### "Cannot resolve dynamic credentials without execution context"

- The webhook trigger doesn't have a User Identifier hook configured
- Ensure the Bearer Token Extractor (or HTTP Header Extractor) is added to the webhook node
- Ensure the caller is sending the `Authorization: Bearer <token>` header

### "Token is not active" / "Token introspection failed"

- The user's identity token is expired or invalid
- Verify the token is valid by calling the introspection/userinfo endpoint directly
- Check that the resolver's metadata URL is correct and accessible from the n8n server

### "Credential resolver data not found"

- The user hasn't completed the OAuth authorization flow yet
- Direct them to `POST /credentials/:id/authorize` to initiate OAuth consent
- If fallback is enabled on the credential (`resolvableAllowFallback`), the static credential will be used instead

### Resolver validation fails on creation

- Ensure the metadata URL returns valid OpenID Connect discovery metadata
- For introspection: verify the `introspection_endpoint` is present in the metadata and supports `client_secret_basic` or `client_secret_post` authentication
- For UserInfo: verify the `userinfo_endpoint` is present in the metadata

### Security: tokens visible in workflow data

- The Bearer Token Extractor automatically **masks** the `Authorization` header value in the webhook output (replaced with `**********`)
- The identity is stored encrypted in the execution context, not in workflow data
- Per-user credentials are stored encrypted in the database

---

## Extending: Custom Credential Resolver

If the built-in OAuth2 resolver doesn't fit your use case, you can create a custom resolver:

1. Create a new file in `packages/cli/src/modules/dynamic-credentials.ee/credential-resolvers/`
2. Implement the `ICredentialResolver` interface with the `@CredentialResolver()` decorator:

```typescript
import { CredentialResolver, ICredentialResolver, CredentialResolverHandle } from '@n8n/decorators';
import { ICredentialContext, ICredentialDataDecryptedObject } from 'n8n-workflow';

@CredentialResolver()
export class MyCustomResolver implements ICredentialResolver {
  metadata = {
    name: 'credential-resolver.my-custom-1.0',
    description: 'My custom credential resolver',
    displayName: 'My Custom Resolver',
    options: [
      // Define configuration options that appear in the UI
    ],
  };

  async getSecret(
    credentialId: string,
    context: ICredentialContext,  // Contains { identity, metadata }
    handle: CredentialResolverHandle,
  ): Promise<ICredentialDataDecryptedObject> {
    // context.identity = the extracted identity (e.g., Bearer token, API key)
    // Use it to look up or derive user-specific credentials
    // Return the credential data object
  }

  async setSecret(
    credentialId: string,
    context: ICredentialContext,
    data: ICredentialDataDecryptedObject,
    handle: CredentialResolverHandle,
  ): Promise<void> {
    // Store user-specific credentials
  }

  async deleteSecret(
    credentialId: string,
    context: ICredentialContext,
    handle: CredentialResolverHandle,
  ): Promise<void> {
    // Delete user-specific credentials
  }
}
```

3. Import the new resolver in `packages/cli/src/modules/dynamic-credentials.ee/credential-resolvers/index.ts`
4. Rebuild n8n

---

*This document describes the Dynamic Credentials feature as implemented in the n8n codebase. This is an Enterprise Edition feature that is not covered in n8n's public documentation.*
