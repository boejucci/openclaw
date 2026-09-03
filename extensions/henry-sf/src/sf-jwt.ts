import { createSign } from "node:crypto";

const JWT_LIFETIME_SECONDS = 180;
const DEFAULT_TIMEOUT_MS = 10_000;

export type MintedCredential = { accessToken: string; instanceUrl: string; issuedAtMs: number };

type TokenErrorBody = { error?: unknown; error_description?: unknown };
type TokenSuccessBody = { access_token?: unknown; instance_url?: unknown };

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function buildAssertion(params: {
  loginUrl: string;
  clientId: string;
  username: string;
  privateKeyPem: string;
  nowSeconds: number;
}): string {
  const header = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
  const claims = base64UrlEncodeJson({
    iss: params.clientId,
    sub: params.username,
    aud: params.loginUrl,
    exp: params.nowSeconds + JWT_LIFETIME_SECONDS,
  });
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(params.privateKeyPem).toString("base64url")}`;
}

function describeTokenError(status: number, body: TokenErrorBody | undefined): string {
  const errorCode = typeof body?.error === "string" ? body.error : undefined;
  const description =
    typeof body?.error_description === "string" ? body.error_description : undefined;
  const reason = errorCode ? ` (${[errorCode, description].filter(Boolean).join(": ")})` : "";
  return `Salesforce JWT bearer token request failed with status ${status}${reason}`;
}

export async function mintSalesforceAccessToken(params: {
  loginUrl: string;
  clientId: string;
  username: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): Promise<MintedCredential> {
  const now = params.now ?? Date.now;
  const fetchImpl = params.fetchImpl ?? fetch;
  const assertion = buildAssertion({
    loginUrl: params.loginUrl,
    clientId: params.clientId,
    username: params.username,
    privateKeyPem: params.privateKeyPem,
    nowSeconds: Math.floor(now() / 1000),
  });
  const requestBody = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetchImpl(`${params.loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: requestBody.toString(),
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const payload: (TokenSuccessBody & TokenErrorBody) | undefined = await response
    .json()
    .catch(() => undefined);

  if (
    !response.ok ||
    typeof payload?.access_token !== "string" ||
    typeof payload?.instance_url !== "string"
  ) {
    throw new Error(describeTokenError(response.status, payload));
  }

  return {
    accessToken: payload.access_token,
    instanceUrl: payload.instance_url,
    issuedAtMs: now(),
  };
}
