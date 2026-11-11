export type Connector = {
  name: string;
  summary: string;
  skill: string;
  mcp: Record<string, unknown>;
};

export const CONNECTORS: Connector[] = [
  {
    name: "sentry",
    summary: "Read crash reports when a ticket is about a production exception.",
    skill: "Use the Sentry connector for crash tickets. If it is not enabled, stop this ticket and say so.",
    mcp: { url: "https://mcp.sentry.dev/mcp" },
  },
  {
    name: "posthog",
    summary: "Read product analytics when a ticket is about what a person did.",
    skill: "Use the PostHog connector for behavior questions. Do not use it for crash stacks.",
    mcp: { url: "https://mcp.posthog.com/mcp" },
  },
  {
    name: "stripe",
    summary: "Read payments when a ticket is about a charge.",
    skill: "Use the Stripe connector for payment tickets.",
    mcp: { url: "https://mcp.stripe.com" },
  },
  {
    name: "figma",
    summary: "Read design structure and copy when a ticket names a frame.",
    skill: "Use the Figma connector for structure and copy. Paint comes from the project, not from the file.",
    mcp: { url: "https://mcp.figma.com/mcp" },
  },
  {
    name: "atlassian",
    summary: "Read Jira issues and attachment evidence for delivery tickets.",
    skill: "Use the Atlassian connector only for read-only Jira evidence. An organization admin must grant only `read_jira` (`read:jira:agent-interface`, including `downloadJiraIssueAttachment`) and `search_jira` (`search:jira:agent-interface`, for JQL discovery), and deny `write_jira`, `delete_jira`, and `manage_jira`; the package's MCP config does not enforce these permissions. For relevant attachment evidence, use the attachment read/download capability, fetch bytes from its returned short-lived URL, and block with an external-evidence blocker if the bytes cannot be retrieved. If network egress is restricted, allow `api.media.atlassian.com` and `*.frontend.public.atl-paas.net` for these downloads.",
    mcp: { url: "https://mcp.atlassian.com/v2/mcp" },
  },
  {
    name: "database",
    summary: "Read the application database when a ticket names a live record.",
    skill: "Use the database connector when a ticket needs a live row. Do not invent the row.",
    mcp: { command: "database-mcp" },
  },
];

export function findConnector(name: string): Connector | undefined {
  return CONNECTORS.find((c) => c.name === name);
}
