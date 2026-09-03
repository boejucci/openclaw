// Henry Salesforce plugin entrypoint registers per-person sf CLI credentials.
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerHenrySf } from "./src/register.js";

export default definePluginEntry({
  id: "henry-sf",
  name: "Henry Salesforce",
  description:
    "Runs every sf CLI call as the requesting person's Salesforce user; no shared credential.",
  register(api: OpenClawPluginApi) {
    registerHenrySf(api);
  },
});
