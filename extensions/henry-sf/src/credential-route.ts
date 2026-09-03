import type { IncomingMessage, ServerResponse } from "node:http";
import { findPerson, type ResolvedHenrySfConfig } from "./config.js";
import type { CredentialService } from "./credential-service.js";
import type { RunLedger } from "./run-ledger.js";
import type { RunTokenIssuer } from "./run-token.js";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const BEARER_TOKEN_PATTERN = /^Bearer\s+(\S+)$/;
// cloudflared forwards tunnel traffic from loopback, so the address alone
// cannot tell the shim apart from a request that came through the tunnel.
// A direct local call never carries proxy or Cloudflare headers.
const PROXIED_REQUEST_HEADERS = [
  "x-forwarded-for",
  "cf-connecting-ip",
  "cf-ray",
  "cf-access-jwt-assertion",
];

function isProxiedRequest(req: IncomingMessage): boolean {
  return PROXIED_REQUEST_HEADERS.some((name) => req.headers[name] !== undefined);
}

function extractBearerToken(header: string | undefined): string | undefined {
  return header ? BEARER_TOKEN_PATTERN.exec(header)?.[1] : undefined;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function createCredentialRouteHandler(params: {
  issuer: RunTokenIssuer;
  config: ResolvedHenrySfConfig;
  credentials: CredentialService;
  runLedger?: RunLedger;
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { issuer, config, credentials, runLedger, logger } = params;
  return async (req, res) => {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "") || isProxiedRequest(req)) {
      sendJson(res, 403, { error: "loopback_only" });
      return true;
    }

    const token = extractBearerToken(req.headers.authorization);
    const claims = token ? issuer.verify(token) : null;
    if (!claims) {
      sendJson(res, 401, { error: "invalid_run_token" });
      return true;
    }
    if (runLedger?.hasEnded(claims.runId)) {
      sendJson(res, 401, { error: "run_ended" });
      return true;
    }

    const person = findPerson(config, claims.senderId);
    if (!person) {
      sendJson(res, 403, { error: "not_provisioned" });
      return true;
    }

    let credential;
    try {
      credential = await credentials.forPerson(person);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[henry-sf] credential mint failed for ${person.profileId}: ${message}`);
      sendJson(res, 502, { error: "mint_failed" });
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        username: credential.username,
        instanceUrl: credential.instanceUrl,
        accessToken: credential.accessToken,
        role: credential.role,
        runId: claims.runId,
      }),
    );
    return true;
  };
}
