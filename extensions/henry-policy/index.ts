// Henry Policy plugin entrypoint — per-person tool policy gate backed by Postgres.
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { registerHenryPolicy } from "./src/register.js";

export default definePluginEntry({
  id: "henry-policy",
  name: "Henry Policy",
  description: "Postgres-backed per-person tool policy gate for the Henry deployment.",
  register(api) {
    registerHenryPolicy(api);
  },
});
