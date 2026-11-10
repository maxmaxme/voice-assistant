import { randomBytes } from 'node:crypto'
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { AuthorizationServerMetadata, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

// One-shot OAuth (DCR + PKCE) that only mints a bearer token for an MCP
// server's `token` field; the assistant itself never refreshes. The panel has
// no HTTPS and OAuth only allows https or localhost redirects, so the browser
// lands on a dead localhost page and the user pastes that URL back.
export const OAUTH_REDIRECT_URI = 'http://localhost/voice-assistant-oauth'

interface Pending {
  authServer: string
  metadata?: AuthorizationServerMetadata
  client: OAuthClientInformationFull
  codeVerifier: string
  resource?: string
  expiresAt: number
}

// shortcut: in-process memory, a panel restart mid-flow means starting the sign-in again.
const pending = new Map<string, Pending>()
const FLOW_TTL_MS = 30 * 60_000
const fetchFn = (url: string | URL, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })

export async function startMcpOauth(serverUrl: string): Promise<{ authorizationUrl: string }> {
  const now = Date.now()
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k)

  const info = await discoverOAuthServerInfo(serverUrl, { fetchFn })
  const metadata = info.authorizationServerMetadata
  if (metadata && !metadata.registration_endpoint) {
    throw new Error('The server supports OAuth but not dynamic client registration — paste a token instead.')
  }
  const client = await registerClient(info.authorizationServerUrl, {
    metadata,
    fetchFn,
    clientMetadata: {
      client_name: 'voice-assistant',
      redirect_uris: [OAUTH_REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  })
  const state = randomBytes(16).toString('base64url')
  const resource = info.resourceMetadata?.resource
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl: OAUTH_REDIRECT_URI,
    scope: info.resourceMetadata?.scopes_supported?.join(' '),
    state,
    resource,
  })
  pending.set(state, { authServer: info.authorizationServerUrl, metadata, client, codeVerifier, resource, expiresAt: now + FLOW_TTL_MS })
  return { authorizationUrl: authorizationUrl.toString() }
}

export async function finishMcpOauth(redirectedUrl: string): Promise<{ token: string, message: string }> {
  let params: URLSearchParams
  try {
    params = new URL(redirectedUrl.trim()).searchParams
  }
  catch {
    throw new Error('Paste the full address from the browser tab (it starts with http://localhost/).')
  }
  const error = params.get('error')
  if (error) {
    throw new Error(`Authorization refused: ${params.get('error_description') ?? error}`)
  }
  const code = params.get('code')
  const flow = pending.get(params.get('state') ?? '')
  if (!code || !flow || flow.expiresAt < Date.now()) {
    throw new Error('Unknown or expired sign-in — click "Get token via OAuth" again.')
  }
  pending.delete(params.get('state')!)
  const tokens = await exchangeAuthorization(flow.authServer, {
    metadata: flow.metadata,
    clientInformation: flow.client,
    authorizationCode: code,
    codeVerifier: flow.codeVerifier,
    redirectUri: OAUTH_REDIRECT_URI,
    resource: flow.resource,
    fetchFn,
  })
  // No refresh in the assistant: a short-lived token stops working at expiry.
  const message = tokens.expires_in
    ? `Token received; it expires in ${Math.round(tokens.expires_in / 60)} min and won't be refreshed — reconnect then.`
    : 'Token received. Save to apply it.'
  return { token: tokens.access_token, message }
}
