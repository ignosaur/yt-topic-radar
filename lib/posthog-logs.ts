import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";

const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST;
const isProduction = process.env.NODE_ENV === "production";

function missingConfiguration(variableName: string): undefined {
  if (!isProduction) {
    throw new Error(
      `${variableName} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variableName} is configured`
    );
  }

  return undefined;
}

const logger = !projectToken
  ? missingConfiguration("POSTHOG_PROJECT_TOKEN")
  : !host
    ? missingConfiguration("POSTHOG_HOST")
    : (() => {
        const provider = new LoggerProvider({
          resource: resourceFromAttributes({ "service.name": "yt-topic-radar" }),
          processors: [
            new BatchLogRecordProcessor(
              new OTLPLogExporter({
                url: new URL("/i/v1/logs", host).toString(),
                headers: { Authorization: `Bearer ${projectToken}` },
              })
            ),
          ],
        });
        return provider.getLogger("yt-topic-radar.posthog");
      })();

export function posthogLog(
  severityText: "info" | "warn" | "error",
  body: string,
  attributes: Record<string, string | number | boolean> = {}
): void {
  logger?.emit({ severityText, body, attributes });
}
