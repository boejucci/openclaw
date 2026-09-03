import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { findPerson, resolveHenrySfConfig, type HenrySfOrg } from "./config.js";
import { createCredentialRouteHandler } from "./credential-route.js";
import { createCredentialService } from "./credential-service.js";
import { createExecPolicyHook } from "./exec-policy.js";
import { createRunLedger } from "./run-ledger.js";
import { createRunTokenIssuer } from "./run-token.js";
import { mintSalesforceAccessToken } from "./sf-jwt.js";

export type HenrySfDeps = {
  mint?: typeof mintSalesforceAccessToken;
  resolveSecret?: (params: { config: unknown; value: unknown; path: string }) => Promise<string>;
  now?: () => number;
};

const DEFAULT_GATEWAY_PORT = 18789;

function createJwtKeyResolver(
  api: OpenClawPluginApi,
  resolveSecret: HenrySfDeps["resolveSecret"],
): (org: HenrySfOrg) => Promise<string> {
  return async (org) => {
    const path = `plugins.entries.henry-sf.config.orgs.${org.key}.jwtKey`;
    if (resolveSecret) {
      return resolveSecret({ config: api.config, value: org.jwtKey, path });
    }
    const resolved = await resolveConfiguredSecretInputString({
      config: api.config,
      env: process.env,
      value: org.jwtKey,
      path,
    });
    if (resolved.value === undefined) {
      throw new Error(
        `henry-sf: jwtKey for org ${org.key} did not resolve: ${resolved.unresolvedRefReason ?? "unknown reason"}`,
      );
    }
    return resolved.value;
  };
}

export function registerHenrySf(api: OpenClawPluginApi, deps: HenrySfDeps = {}): void {
  const config = resolveHenrySfConfig({ pluginConfig: api.pluginConfig });
  if (config.people.size === 0) {
    api.logger.info?.("[henry-sf] no people configured; plugin inactive");
    return;
  }

  const issuer = createRunTokenIssuer({ ttlSeconds: config.runTokenTtlSeconds, now: deps.now });
  const runLedger = createRunLedger({ ttlSeconds: config.runTokenTtlSeconds, now: deps.now });
  const credentials = createCredentialService({
    config,
    resolveJwtKey: createJwtKeyResolver(api, deps.resolveSecret),
    mint: deps.mint,
    now: deps.now,
  });
  const credentialUrl =
    config.credentialUrl ??
    `http://127.0.0.1:${api.config.gateway?.port ?? DEFAULT_GATEWAY_PORT}${config.routePath}`;

  api.registerHttpRoute({
    path: config.routePath,
    auth: "plugin",
    match: "exact",
    handler: createCredentialRouteHandler({
      issuer,
      config,
      credentials,
      runLedger,
      logger: api.logger,
    }),
  });

  api.on("resolve_exec_env", (event, ctx) => {
    if (event.host !== "gateway" || !ctx.runId || !ctx.senderId) {
      return {};
    }
    if (!findPerson(config, ctx.senderId)) {
      return {};
    }
    return {
      HENRY_SF_RUN_TOKEN: issuer.issue({ runId: ctx.runId, senderId: ctx.senderId }),
      HENRY_SF_CREDENTIAL_URL: credentialUrl,
    };
  });

  api.on("before_tool_call", createExecPolicyHook({ config }), {
    matcher: ["exec"],
    priority: 100,
  });

  // A token printed into a shared transcript must not outlive its run.
  api.on("agent_end", (event, ctx) => {
    const runId = ctx.runId ?? event.runId;
    if (runId) {
      runLedger.markEnded(runId);
    }
  });

  api.logger.info?.(
    `[henry-sf] ${config.people.size} people, ${config.orgs.size} orgs, route ${config.routePath}`,
  );
}
