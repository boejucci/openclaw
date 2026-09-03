---
summary: "Run every sf CLI call as the requesting person's own Salesforce user, with no shared credential"
read_when:
  - You want agents to run Salesforce CLI commands as the person who asked, not a shared service account
  - You are setting up per-person Salesforce access on a shared OpenClaw Gateway
  - You are configuring the Connected App, JWT key, or exec host this plugin needs
  - You are auditing what a member can and cannot do with sf
title: "Henry Salesforce plugin"
---

# Henry Salesforce plugin

The henry-sf plugin lets every `sf` (Salesforce CLI) command an agent runs
through `exec` execute as the Salesforce user of the person whose turn
triggered it, with no shared credential anywhere on the box. It mints a
short-lived per-person access token over the Salesforce JWT bearer flow,
hands it to a `sf` shim through a loopback-only Gateway route, and
classifies every subcommand so members are held to read-only calls while the
configured admin can deploy. The plugin stays inactive until at least one
person is configured under `plugins.entries.henry-sf.config.people`.

## How it works

```
person's turn (profile id in SenderId, Plan 1)
  → embedded run; hook context carries requester.senderId and runId
  → model calls exec: "sf data query -q '...'"
  → before_tool_call (henry-sf, matcher exec):
        unknown requester → block; member + write subcommand → block; sf org display → block
  → resolve_exec_env (henry-sf): ctx.senderId + ctx.runId → HMAC run token, 15 min
        env: HENRY_SF_RUN_TOKEN, HENRY_SF_CREDENTIAL_URL (loopback route)
  → shell resolves `sf` to the shim (/opt/henry/bin first on the service PATH)
  → shim: GET http://127.0.0.1:<gateway-port>/henry/sf/credential  Authorization: Bearer <run token>
  → route (auth: "plugin"): loopback only → verify token → person → org → JWT bearer mint
        (cached per person ~30 min) → { username, instanceUrl, accessToken, role }
  → shim: fresh HOME under /tmp, `sf org login access-token` with SF_ACCESS_TOKEN,
        then the real sf with the person's argv, then rm -rf HOME
```

## Configuration

Set config under `plugins.entries.henry-sf.config`. Profile ids are the `id`
values in `openclaw users list`:

```json5
{
  plugins: {
    entries: {
      "henry-sf": {
        enabled: true,
        config: {
          people: {
            "<joe-profile-id>": { username: "joe.bucci@isidefense.com", role: "admin" },
            "<member-profile-id>": { username: "person@isidefense.com", role: "member" },
          },
          orgs: {
            prod: {
              instanceUrl: "https://isidefense.my.salesforce.com",
              clientId: "<connected app consumer key>",
              jwtKey: { source: "file", provider: "default", id: "henry-sf-jwt-key" },
              default: true,
            },
          },
        },
      },
    },
  },
  tools: { exec: { host: "gateway" } },
}
```

`role` is `"admin"` or `"member"`. A person who omits `org` is assigned to
whichever org has `default: true`; add more than one org only when some
people need a different one, such as a sandbox, named explicitly on their
entry. `jwtKey` accepts a plain string or a [SecretRef](/gateway/secrets).

## Host setup

Set `tools.exec.host: "gateway"` as shown above. This plugin only produces a
credential for exec runs on the `gateway` host; a `host: "sandbox"` run gets
no token at all (see Known limits below).

The systemd unit that runs the Gateway needs the shim ahead of the real `sf`
on `PATH`, plus the real binary's location so the shim can hand off to it:

```
Environment=PATH=/opt/henry/bin:/usr/local/bin:/usr/bin:/bin
Environment=HENRY_SF_REAL_BIN=/usr/local/bin/sf
```

Copy `extensions/henry-sf/shim/sf.mjs` to `/opt/henry/bin/sf` (mode `755`).
That copy is what the shell resolves when a command runs `sf`; it signs in
under a throwaway `HOME` and then execs the real CLI at `HENRY_SF_REAL_BIN`.

As defense in depth, keep the credential path off the public hostname in the
tunnel's ingress rules, ahead of the catch-all:

```yaml
ingress:
  - hostname: henry.example.com
    path: ^/henry/sf/
    service: http_status:404
  - hostname: henry.example.com
    service: http://localhost:18789
```

## Trust model and known limits

Guaranteed by this plugin:

- The run token is bound to the exact `(runId, senderId)` pair, HMAC-signed
  with a process-random secret, and expires in 15 minutes. It is minted only
  when the requester is a configured person and the exec host is `gateway`.
- The credential route accepts loopback connections only and refuses any
  request that carries proxy or Cloudflare headers (`cloudflared` forwards
  tunnel traffic from loopback, so the address alone is not proof). It stops
  honouring a run's token the moment that run ends, returns a credential only
  for the person the token names, and never logs it.
- The JWT private key never leaves the Gateway process; it is a SecretRef in
  plugin config, resolved in memory.
- Each `sf` invocation gets a throwaway `HOME`, and nothing persists on disk
  between commands. `sf org display`, `sf org open`, and `sf org list` are
  refused for everyone, because their output carries a live session
  credential that a shared-session transcript would then expose to other
  participants.
- Cron, heartbeat, and subagent runs have no requester and therefore get no
  token.

Known limits, stated plainly:

- The read-only policy for members is a Henry layer, not a Salesforce one. A
  member's model could call the credential route directly with its own run
  token and use that person's own access token over REST. That token is
  still the member's own Salesforce identity, so the real boundary is
  Salesforce's profiles and permission sets, which the admin controls when
  pre-authorizing users on the Connected App. What this plugin actually
  guarantees is narrower, and it is the one that matters on a shared box:
  nobody ever gets anyone else's credential.
- While a run is in progress its run token is visible to that run's own
  commands, so a model that prints its environment into a shared transcript
  exposes a token that another local process could redeem until the run
  ends. OpenClaw does not redact plugin-injected environment values, so the
  transcript is the exposure to watch; the hard stop is `agent_end`, which
  retires the token, and the 15-minute TTL bounds the rest.
- `host: "sandbox"` exec runs are unsupported. The `resolve_exec_env` hook
  returns nothing for a non-`gateway` host, and the shim fails closed with no
  token. Run the Gateway with `tools.exec.host: "gateway"` for this plugin to
  do anything.

## Salesforce prerequisites

- A Connected App with digital signatures enabled: upload the certificate
  whose matching private key the plugin holds as `jwtKey`, so it can sign
  the JWT bearer assertion.
- OAuth scopes `api` and `refresh_token, offline_access`.
- Permitted Users set to "Admin approved users are pre-authorized".
- Every configured person assigned to the Connected App through a profile or
  a permission set; an unauthorized user's calls fail credential minting.
- The JWT `sub` claim is each person's Salesforce username, so the
  `username` in a person's entry must be an active Salesforce user's exact
  username.

## Related

- [Plugin hooks](/plugins/hooks) - the `resolve_exec_env` and
  `before_tool_call` hooks this plugin registers
- [Secrets](/gateway/secrets) - SecretRef sources accepted by `jwtKey`
