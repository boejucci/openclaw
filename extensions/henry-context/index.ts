import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { registerHenryContext } from "./src/register.js";

export default definePluginEntry({
  id: "henry-context",
  name: "Henry Context",
  description:
    "Injects per-person and team context into every turn; persists per-person memory at session end.",
  register(api) {
    registerHenryContext(api);
  },
});
