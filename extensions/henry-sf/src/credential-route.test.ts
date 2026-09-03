import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { HenrySfPerson, ResolvedHenrySfConfig } from "./config.js";
import { createCredentialRouteHandler } from "./credential-route.js";
import type { CredentialService, PersonCredential } from "./credential-service.js";
import { createRunTokenIssuer } from "./run-token.js";

const PERSON: HenrySfPerson = {
  profileId: "profile-ada",
  username: "ada@isidefense.com",
  role: "member",
  orgKey: "prod",
};

function buildConfig(
  people: Record<string, HenrySfPerson> = { [PERSON.profileId]: PERSON },
): ResolvedHenrySfConfig {
  return {
    people: new Map(Object.entries(people)),
    orgs: new Map(),
    routePath: "/henry/sf/credential",
    runTokenTtlSeconds: 900,
    credentialCacheSeconds: 1800,
  };
}

function fixedCredential(person: HenrySfPerson): PersonCredential {
  return {
    accessToken: "secret-access-token",
    instanceUrl: "https://isi.my.salesforce.com",
    issuedAtMs: 0,
    username: person.username,
    role: person.role,
    orgKey: person.orgKey,
  };
}

function buildStubCredentialService(
  impl: (person: HenrySfPerson) => Promise<PersonCredential> = (person) =>
    Promise.resolve(fixedCredential(person)),
): CredentialService {
  return { forPerson: vi.fn(impl) };
}

function fakeRequest(params: {
  method?: string;
  authorization?: string;
  remoteAddress?: string;
}): IncomingMessage {
  return {
    method: params.method ?? "GET",
    headers: params.authorization !== undefined ? { authorization: params.authorization } : {},
    socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  let body = "";
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") {
        body = chunk;
      }
    },
  };
  return {
    res: res as unknown as ServerResponse,
    getStatusCode: () => res.statusCode,
    getHeaders: () => headers,
    getBody: (): unknown => (body ? JSON.parse(body) : undefined),
  };
}

function buildHandlerParams(
  overrides: {
    config?: ResolvedHenrySfConfig;
    credentials?: CredentialService;
    logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  } = {},
) {
  const issuer = createRunTokenIssuer({
    ttlSeconds: 900,
    secret: Buffer.from("fixed-test-secret"),
    now: () => 0,
  });
  return {
    issuer,
    config: overrides.config ?? buildConfig(),
    credentials: overrides.credentials ?? buildStubCredentialService(),
    logger: overrides.logger ?? { warn: vi.fn() },
  };
}

describe("createCredentialRouteHandler", () => {
  it("rejects a non-GET method with 405 regardless of address or auth", async () => {
    const params = buildHandlerParams();
    const handler = createCredentialRouteHandler(params);
    const req = fakeRequest({ method: "POST", remoteAddress: "10.0.0.5" });
    const { res, getStatusCode, getBody } = fakeResponse();

    await expect(handler(req, res)).resolves.toBe(true);
    expect(getStatusCode()).toBe(405);
    expect(getBody()).toEqual({ error: "method_not_allowed" });
  });

  it("rejects a non-loopback caller with 403", async () => {
    const params = buildHandlerParams();
    const handler = createCredentialRouteHandler(params);
    const req = fakeRequest({ remoteAddress: "10.0.0.5" });
    const { res, getStatusCode, getBody } = fakeResponse();

    await expect(handler(req, res)).resolves.toBe(true);
    expect(getStatusCode()).toBe(403);
    expect(getBody()).toEqual({ error: "loopback_only" });
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "accepts the loopback address %s",
    async (remoteAddress) => {
      const params = buildHandlerParams();
      const handler = createCredentialRouteHandler(params);
      const token = params.issuer.issue({ runId: "run-1", senderId: PERSON.profileId });
      const req = fakeRequest({ remoteAddress, authorization: `Bearer ${token}` });
      const { res, getStatusCode } = fakeResponse();

      await expect(handler(req, res)).resolves.toBe(true);
      expect(getStatusCode()).toBe(200);
    },
  );

  it("rejects a missing Authorization header with 401", async () => {
    const params = buildHandlerParams();
    const handler = createCredentialRouteHandler(params);
    const req = fakeRequest({});
    const { res, getStatusCode, getBody } = fakeResponse();

    await expect(handler(req, res)).resolves.toBe(true);
    expect(getStatusCode()).toBe(401);
    expect(getBody()).toEqual({ error: "invalid_run_token" });
  });

  it.each([
    ["no Bearer scheme", "some-token"],
    ["wrong scheme", "Basic some-token"],
    ["scheme with no token", "Bearer"],
    ["scheme with only whitespace", "Bearer "],
    ["extra segments after the token", "Bearer abc def"],
  ])("rejects a malformed Authorization header (%s) with 401", async (_label, authorization) => {
    const params = buildHandlerParams();
    const handler = createCredentialRouteHandler(params);
    const req = fakeRequest({ authorization });
    const { res, getStatusCode, getBody } = fakeResponse();

    await expect(handler(req, res)).resolves.toBe(true);
    expect(getStatusCode()).toBe(401);
    expect(getBody()).toEqual({ error: "invalid_run_token" });
  });

  it("rejects a well-formed token that issuer.verify rejects with 401", async () => {
    const params = buildHandlerParams();
    const handler = createCredentialRouteHandler(params);
    const otherIssuer = createRunTokenIssuer({
      ttlSeconds: 900,
      secret: Buffer.from("a-different-secret"),
      now: () => 0,
    });
    const token = otherIssuer.issue({ runId: "run-1", senderId: PERSON.profileId });
    const req = fakeRequest({ authorization: `Bearer ${token}` });
    const { res, getStatusCode, getBody } = fakeResponse();

    await expect(handler(req, res)).resolves.toBe(true);
    expect(getStatusCode()).toBe(401);
    expect(getBody()).toEqual({ error: "invalid_run_token" });
  });

  it("returns 403 not_provisioned for a valid token whose senderId is not configured", async () => {
    const params = buildHandlerParams();
    const handler = createCredentialRouteHandler(params);
    const token = params.issuer.issue({ runId: "run-1", senderId: "profile-unconfigured" });
    const req = fakeRequest({ authorization: `Bearer ${token}` });
    const { res, getStatusCode, getBody } = fakeResponse();

    await expect(handler(req, res)).resolves.toBe(true);
    expect(getStatusCode()).toBe(403);
    expect(getBody()).toEqual({ error: "not_provisioned" });
  });

  it("returns 502 mint_failed and warns once without leaking the run token", async () => {
    const warn = vi.fn();
    const credentials = buildStubCredentialService(() =>
      Promise.reject(
        new Error("Salesforce JWT bearer token request failed with status 400 (invalid_grant)"),
      ),
    );
    const params = buildHandlerParams({ credentials, logger: { warn } });
    const handler = createCredentialRouteHandler(params);
    const token = params.issuer.issue({ runId: "run-1", senderId: PERSON.profileId });
    const req = fakeRequest({ authorization: `Bearer ${token}` });
    const { res, getStatusCode, getBody } = fakeResponse();

    await expect(handler(req, res)).resolves.toBe(true);
    expect(getStatusCode()).toBe(502);
    expect(getBody()).toEqual({ error: "mint_failed" });
    expect(warn).toHaveBeenCalledTimes(1);
    const [warnedMessage] = warn.mock.calls[0] as [string];
    expect(warnedMessage).toContain("invalid_grant");
    expect(warnedMessage).not.toContain(token);
  });

  it("returns 200 with exactly five keys and the right headers on success", async () => {
    const params = buildHandlerParams();
    const handler = createCredentialRouteHandler(params);
    const token = params.issuer.issue({ runId: "run-42", senderId: PERSON.profileId });
    const req = fakeRequest({ authorization: `Bearer ${token}` });
    const { res, getStatusCode, getHeaders, getBody } = fakeResponse();

    await expect(handler(req, res)).resolves.toBe(true);

    expect(getStatusCode()).toBe(200);
    expect(getHeaders()["content-type"]).toBe("application/json");
    expect(getHeaders()["cache-control"]).toBe("no-store");
    const body = getBody() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["accessToken", "instanceUrl", "role", "runId", "username"].sort(),
    );
    expect(body).toEqual({
      username: PERSON.username,
      instanceUrl: "https://isi.my.salesforce.com",
      accessToken: "secret-access-token",
      role: PERSON.role,
      runId: "run-42",
    });
    expect(params.credentials.forPerson).toHaveBeenCalledWith(PERSON);
  });
});
