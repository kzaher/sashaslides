/**
 * The endpoint surface of the remote server, and the two discovery documents Claude reads
 * to find it. Pure functions of one `publicUrl`, so a test can assert the documents
 * without starting a listener.
 *
 * Claude is stricter than the MCP authorization spec in ways that are load-bearing here:
 *
 *  - `resource` in the protected resource metadata MUST equal the MCP endpoint URL
 *    **exactly, including the path**. Hence `mcpUrl`, not the origin.
 *  - Claude uses only the FIRST entry of `authorization_servers` and does not fall back,
 *    so the list is a single element: this server, co-hosting its own AS (which the spec
 *    permits: "the authorization server ... MAY be co-hosted").
 *  - PKCE S256 must be advertised, and it is the only method we accept.
 *  - CIMD is selected only when metadata advertises BOTH
 *    `client_id_metadata_document_supported: true` AND `"none"` in
 *    `token_endpoint_auth_methods_supported`. We need `"none"` (our clients are public and
 *    prove themselves with PKCE), so CIMD is advertised as explicitly `false` to push
 *    Claude onto the DCR path we actually implement.
 */

export const MCP_PATH = "/mcp";
export const AUTHORIZE_PATH = "/authorize";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";
/** Where Google sends the user back to us. Registered with Google, never with Claude. */
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * The scopes our access token stands for. They are the Google scopes verbatim, because
 * that is exactly what the token lets a caller do: `presentations` + `drive.file` are what
 * `proposal.ts` needs, and `openid`/`email` are what identifies the user we act as.
 * `drive.file` is non-sensitive (PROTOCOL.md "Drive layout"); full `drive` is restricted
 * and is deliberately not requested here.
 */
/* Kept as literals, not imported from `google-auth.ts`, so this module stays a pure
 * function of `publicUrl` with no googleapis dependency. `user-drive.ts` checks the
 * granted scopes against `google-auth.ts`'s constants, which is where drift would bite. */
export const BROKERED_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive.file",
] as const;

export type Endpoints = Readonly<{
  /** Origin plus optional base path, no trailing slash. Also the AS issuer. */
  publicUrl: string;
  /** The MCP endpoint, and the `resource` identifier. */
  mcpUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  registerUrl: string;
  googleCallbackUrl: string;
  protectedResourceMetadataUrl: string;
  authorizationServerMetadataUrl: string;
}>;

export function endpointsFor(options: Readonly<{ publicUrl: string }>): Endpoints {
  const publicUrl = options.publicUrl.replace(/\/+$/, "");
  return {
    publicUrl,
    mcpUrl: `${publicUrl}${MCP_PATH}`,
    authorizeUrl: `${publicUrl}${AUTHORIZE_PATH}`,
    tokenUrl: `${publicUrl}${TOKEN_PATH}`,
    registerUrl: `${publicUrl}${REGISTER_PATH}`,
    googleCallbackUrl: `${publicUrl}${GOOGLE_CALLBACK_PATH}`,
    // RFC 9728 section 3.1: the resource's path is appended to the well-known path, so a
    // resource at /mcp advertises /.well-known/oauth-protected-resource/mcp.
    protectedResourceMetadataUrl: `${publicUrl}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`,
    authorizationServerMetadataUrl: `${publicUrl}${AUTHORIZATION_SERVER_METADATA_PATH}`,
  };
}

/** RFC 9728. `resource` is the exact MCP URL; `authorization_servers[0]` is us. */
export type ProtectedResourceMetadata = Readonly<{
  resource: string;
  authorization_servers: readonly string[];
  scopes_supported: readonly string[];
  bearer_methods_supported: readonly string[];
  resource_name: string;
}>;

export function protectedResourceMetadata(
  options: Readonly<{ endpoints: Endpoints; resourceName: string }>,
): ProtectedResourceMetadata {
  return {
    resource: options.endpoints.mcpUrl,
    authorization_servers: [options.endpoints.publicUrl],
    scopes_supported: [...BROKERED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: options.resourceName,
  };
}

/** RFC 8414, plus the fields Claude's connector flow keys off. */
export type AuthorizationServerMetadata = Readonly<{
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: readonly string[];
  grant_types_supported: readonly string[];
  code_challenge_methods_supported: readonly string[];
  token_endpoint_auth_methods_supported: readonly string[];
  scopes_supported: readonly string[];
  /** Explicitly false: we implement DCR, not CIMD. See this file's header. */
  client_id_metadata_document_supported: boolean;
}>;

export function authorizationServerMetadata(
  options: Readonly<{ endpoints: Endpoints }>,
): AuthorizationServerMetadata {
  const { endpoints } = options;
  return {
    issuer: endpoints.publicUrl,
    authorization_endpoint: endpoints.authorizeUrl,
    token_endpoint: endpoints.tokenUrl,
    registration_endpoint: endpoints.registerUrl,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...BROKERED_SCOPES],
    client_id_metadata_document_supported: false,
  };
}

/**
 * The `WWW-Authenticate` value for the 401 that starts the whole flow.
 *
 * Claude's connector docs are blunt about this: the 401 is required, and a
 * `WWW-Authenticate` header on a 200 is ignored. So this is never attached to a success
 * response — see `http-server.ts`.
 */
export function bearerChallenge(
  options: Readonly<{ endpoints: Endpoints; error: "missing-token" | "invalid_token"; description: string }>,
): string {
  const parts = [
    `Bearer resource_metadata="${options.endpoints.protectedResourceMetadataUrl}"`,
    `resource="${options.endpoints.mcpUrl}"`,
  ];
  if (options.error === "invalid_token") {
    parts.push('error="invalid_token"', `error_description="${sanitizeQuotedString(options.description)}"`);
  }
  return parts.join(", ");
}

/** A header value cannot carry a raw quote or newline; nothing here needs to. */
function sanitizeQuotedString(value: string): string {
  return value.replace(/[\\"]/g, "").replace(/[\r\n]+/g, " ");
}
