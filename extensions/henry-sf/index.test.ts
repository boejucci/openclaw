import type { IncomingMessage, ServerResponse } from "node:http";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { registerHenrySf } from "./src/register.js";
import { mintSalesforceAccessToken, type MintedCredential } from "./src/sf-jwt.js";

const ADMIN_PROFILE_ID = "profile-joe";
const MEMBER_PROFILE_ID = "profile-ada";
const GATEWAY_PORT = 18789;
const CREDENTIAL_URL = `http://127.0.0.1:${GATEWAY_PORT}/henry/sf/credential`;

type CapturedHandler = (event: unknown, ctx: unknown) => unknown;
type CapturedRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

function buildPluginConfig(): Record<string, unknown> {
  return {
    people: {
      [ADMIN_PROFILE_ID]: { username: "joe@isidefense.com", role: "admin" },
      [MEMBER_PROFILE_ID]: { username: "ada@isidefense.com", role: "member" },
    },
    orgs: {
      prod: {
        instanceUrl: "https://isi.my.salesforce.com",
        clientId: "consumer-key",
        jwtKey: "PEM",
        default: true,
      },
    },
  };
}

function fixedCredential(): MintedCredential {
  return {
    accessToken: "minted-access-token",
    instanceUrl: "https://isi.my.salesforce.com",
    issuedAtMs: 0,
  };
}

function fakeRequest(
  params: { authorization?: string; remoteAddress?: string } = {},
): IncomingMessage {
  return {
    method: "GET",
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
    getBody: (): Record<string, unknown> | undefined => (body ? JSON.parse(body) : undefined),
  };
}

function buildTestApi(pluginConfig: Record<string, unknown> = buildPluginConfig()) {
  const on = vi.fn();
  const registerHttpRoute = vi.fn();
  const info = vi.fn();
  const api = createTestPluginApi({
    id: "henry-sf",
    name: "Henry Salesforce",
    source: "test",
    config: { gateway: { port: GATEWAY_PORT } },
    pluginConfig,
    registerHttpRoute,
    on,
    logger: { info, warn: vi.fn(), error: vi.fn() },
  });
  return { api, on, registerHttpRoute, info };
}

function findHook(on: ReturnType<typeof vi.fn>, hookName: string): CapturedHandler {
  const handler = on.mock.calls.find(([name]: [string]) => name === hookName)?.[1];
  if (typeof handler !== "function") {
    throw new Error(`${hookName} was not registered`);
  }
  return handler as CapturedHandler;
}

function findResolveExecEnv(on: ReturnType<typeof vi.fn>): CapturedHandler {
  return findHook(on, "resolve_exec_env");
}

function findRouteHandler(registerHttpRoute: ReturnType<typeof vi.fn>): CapturedRouteHandler {
  const handler = registerHttpRoute.mock.calls[0]?.[0]?.handler;
  if (typeof handler !== "function") {
    throw new Error("credential route was not registered");
  }
  return handler as CapturedRouteHandler;
}

describe("henry-sf plugin", () => {
  it("registers the credential route on the configured path with plugin auth", () => {
    const { api, registerHttpRoute } = buildTestApi();

    plugin.register(api);

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/henry/sf/credential", auth: "plugin", match: "exact" }),
    );
  });

  it("registers resolve_exec_env and before_tool_call with the exec matcher and priority", () => {
    const { api, on } = buildTestApi();

    plugin.register(api);

    expect(on).toHaveBeenCalledWith("resolve_exec_env", expect.any(Function));
    expect(on).toHaveBeenCalledWith("before_tool_call", expect.any(Function), {
      matcher: ["exec"],
      priority: 100,
    });
  });

  it("gates resolve_exec_env on gateway host, a full runId/senderId pair, and a configured person", () => {
    const { api, on } = buildTestApi();

    plugin.register(api);
    const resolveExecEnv = findResolveExecEnv(on);

    expect(
      resolveExecEnv({ host: "sandbox" }, { runId: "run-1", senderId: ADMIN_PROFILE_ID }),
    ).toEqual({});
    expect(resolveExecEnv({ host: "gateway" }, { runId: "run-1" })).toEqual({});
    expect(resolveExecEnv({ host: "gateway" }, { senderId: ADMIN_PROFILE_ID })).toEqual({});
    expect(
      resolveExecEnv({ host: "gateway" }, { runId: "run-1", senderId: "profile-unknown" }),
    ).toEqual({});

    const result = resolveExecEnv(
      { host: "gateway" },
      { runId: "run-1", senderId: ADMIN_PROFILE_ID },
    ) as Record<string, string>;
    expect(result.HENRY_SF_CREDENTIAL_URL).toBe(CREDENTIAL_URL);
    expect(result.HENRY_SF_RUN_TOKEN.length).toBeGreaterThan(0);
  });

  it("mints a credential for the run token's person and returns it through the route", async () => {
    const mint = vi.fn<typeof mintSalesforceAccessToken>().mockResolvedValue(fixedCredential());
    const { api, on, registerHttpRoute } = buildTestApi();

    registerHenrySf(api, { mint });
    const resolveExecEnv = findResolveExecEnv(on);
    const routeHandler = findRouteHandler(registerHttpRoute);

    const env = resolveExecEnv(
      { host: "gateway" },
      { runId: "run-1", senderId: ADMIN_PROFILE_ID },
    ) as Record<string, string>;
    const req = fakeRequest({ authorization: `Bearer ${env.HENRY_SF_RUN_TOKEN}` });
    const { res, getStatusCode, getBody } = fakeResponse();

    await routeHandler(req, res);

    expect(getStatusCode()).toBe(200);
    expect(getBody()).toMatchObject({ username: "joe@isidefense.com" });
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "consumer-key",
        loginUrl: "https://login.salesforce.com",
        username: "joe@isidefense.com",
        privateKeyPem: "PEM",
      }),
    );
  });

  it("caches a minted credential per person across separate run tokens", async () => {
    const mint = vi.fn<typeof mintSalesforceAccessToken>().mockResolvedValue(fixedCredential());
    const { api, on, registerHttpRoute } = buildTestApi();

    registerHenrySf(api, { mint });
    const resolveExecEnv = findResolveExecEnv(on);
    const routeHandler = findRouteHandler(registerHttpRoute);

    async function callAs(senderId: string, runId: string): Promise<void> {
      const env = resolveExecEnv({ host: "gateway" }, { runId, senderId }) as Record<
        string,
        string
      >;
      const req = fakeRequest({ authorization: `Bearer ${env.HENRY_SF_RUN_TOKEN}` });
      const { res, getStatusCode } = fakeResponse();
      await routeHandler(req, res);
      expect(getStatusCode()).toBe(200);
    }

    await callAs(MEMBER_PROFILE_ID, "run-1");
    await callAs(ADMIN_PROFILE_ID, "run-2");
    await callAs(MEMBER_PROFILE_ID, "run-3");
    await callAs(ADMIN_PROFILE_ID, "run-4");

    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("stays inactive with no people configured: no route, no hooks", () => {
    const { api, on, registerHttpRoute, info } = buildTestApi({});

    plugin.register(api);

    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("inactive"));
  });

  it("throws out of register when a person names an unknown org", () => {
    const { api } = buildTestApi({
      people: {
        [ADMIN_PROFILE_ID]: { username: "joe@isidefense.com", role: "admin", org: "sandbox" },
      },
      orgs: {
        prod: {
          instanceUrl: "https://isi.my.salesforce.com",
          clientId: "consumer-key",
          jwtKey: "PEM",
        },
      },
    });

    expect(() => plugin.register(api)).toThrow(/references unknown org "sandbox"/);
  });

  it("stops honouring a run's token once agent_end fires for that run", async () => {
    const { api, on, registerHttpRoute } = buildTestApi();
    const mint = vi.fn<typeof mintSalesforceAccessToken>().mockResolvedValue(fixedCredential());
    registerHenrySf(api, { mint });

    const env = findResolveExecEnv(on)(
      { host: "gateway" },
      { runId: "run-9", senderId: ADMIN_PROFILE_ID },
    ) as Record<string, string>;
    const route = findRouteHandler(registerHttpRoute);

    const live = fakeResponse();
    await route(fakeRequest({ authorization: `Bearer ${env.HENRY_SF_RUN_TOKEN}` }), live.res);
    expect(live.getStatusCode()).toBe(200);

    findHook(on, "agent_end")({ runId: "run-9", messages: [], success: true }, { runId: "run-9" });

    const ended = fakeResponse();
    await route(fakeRequest({ authorization: `Bearer ${env.HENRY_SF_RUN_TOKEN}` }), ended.res);
    expect(ended.getStatusCode()).toBe(401);
    expect(ended.getBody()).toEqual({ error: "run_ended" });
  });
});
