import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = "hsf1";

export type RunTokenClaims = { runId: string; senderId: string; exp: number };

export type RunTokenIssuer = {
  issue(params: { runId: string; senderId: string }): string;
  verify(token: string): RunTokenClaims | null;
};

function base64UrlEncode(input: string | Buffer): string {
  return (typeof input === "string" ? Buffer.from(input, "utf8") : input).toString("base64url");
}

function isRunTokenClaims(value: unknown): value is RunTokenClaims {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { runId, senderId, exp } = value as Record<string, unknown>;
  return (
    typeof runId === "string" &&
    runId.length > 0 &&
    typeof senderId === "string" &&
    senderId.length > 0 &&
    Number.isInteger(exp)
  );
}

export function createRunTokenIssuer(params: {
  ttlSeconds: number;
  secret?: Buffer;
  now?: () => number;
}): RunTokenIssuer {
  const secret = params.secret ?? randomBytes(32);
  const now = params.now ?? Date.now;
  const ttlMs = params.ttlSeconds * 1000;

  function sign(body: string): Buffer {
    return createHmac("sha256", secret).update(body).digest();
  }

  return {
    issue({ runId, senderId }) {
      if (runId.length === 0 || senderId.length === 0) {
        throw new Error("henry-sf run token requires a non-empty runId and senderId");
      }
      const claims: RunTokenClaims = { runId, senderId, exp: now() + ttlMs };
      const body = `${TOKEN_VERSION}.${base64UrlEncode(JSON.stringify(claims))}`;
      return `${body}.${base64UrlEncode(sign(body))}`;
    },
    verify(token) {
      try {
        const [version, claimsPart, signaturePart, ...rest] = token.split(".");
        if (rest.length > 0 || version !== TOKEN_VERSION || !claimsPart || !signaturePart) {
          return null;
        }
        const body = `${version}.${claimsPart}`;
        const providedSignature = Buffer.from(signaturePart, "base64url");
        const expectedSignature = sign(body);
        if (
          providedSignature.length !== expectedSignature.length ||
          !timingSafeEqual(providedSignature, expectedSignature)
        ) {
          return null;
        }
        const claims: unknown = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8"));
        if (!isRunTokenClaims(claims) || claims.exp <= now()) {
          return null;
        }
        return claims;
      } catch {
        return null;
      }
    },
  };
}
