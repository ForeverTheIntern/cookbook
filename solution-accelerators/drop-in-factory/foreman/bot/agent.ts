import { defineAgent } from "@cursor/bdk";
import { dashboardHost } from "./lib/hosting.ts";

// Foreman only chats. Built-in file and shell tools stay off: it has no
// checkout, and its two tools read the store and pass on an answer.
export default defineAgent({
  model: {
    id: "grok-4.5",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
  tools: [],
  hosting: {
    // `bdk deploy` evaluates this once, so a hosted dashboard's host
    // comes from dashboard.url in factory.yaml, not SA_PORTAL_URL.
    // files.slack.com takes the verify video upload; the agent-stores bucket serves the video from the Cloud Agents API.
    egressDomains: ["api.github.com", "api.cursor.com", "slack.com", "files.slack.com", "agent-stores.s3.us-east-1.amazonaws.com", ...dashboardHost()],
    secretNames: [
      "SA_GH_TOKEN",
      "SA_GH_APP_ID",
      "SA_GH_APP_PRIVATE_KEY",
      "SA_GH_BOT_TOKEN",
      "SA_CURSOR_API_KEY",
      "SA_CURSOR_ADMIN_API_KEY",
      "FOREMAN_SLACK_BOT_TOKEN",
      "FOREMAN_SLACK_APP_TOKEN",
      "SA_PORTAL_INGEST_SECRET",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
    ],
  },
});
