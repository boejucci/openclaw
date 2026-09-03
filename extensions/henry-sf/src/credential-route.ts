import type { IncomingMessage, ServerResponse } from "node:http";
import { findPerson, type ResolvedHenrySfConfig } from "./config.js";
import type { CredentialService } from "./credential-service.js";
import type { RunTokenIssuer } from "./run-token.js";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const BEARER_TOKEN_PATTERN = /^Bearer\s+(\S+)$/;

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
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { issuer, config, credentials, logger } = params;
  return async (req, res) => {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) {
      sendJson(res, 403, { error: "loopback_only" });
      return true;
    }

    const token = extractBearerToken(req.headers.authorization);
    const claims = token ? issuer.verify(token) : null;
    if (!claims) {
      sendJson(res, 401, { error: "invalid_run_token" });
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
