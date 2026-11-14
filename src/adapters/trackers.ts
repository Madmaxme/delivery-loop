import { createHash } from "node:crypto";
import {
  credentialFetch,
  githubEndpointClass,
  type CredentialNoteFn,
} from "../engine/credential-log.ts";
import { figmaUrlsFromText } from "../engine/design-gate.ts";
import type { IssueBlocker, LinearProgramSnapshot } from "../engine/linear-harness-policy.js";
import type { JiraConfig } from "../schema/pack.ts";
import type {
  DeliveryState,
  FetchLike,
  JsonValue,
  LinearProgramTracker,
  Ticket,
  TicketAttachment,
  TicketComment,
  TrackerAdapter,
  TrackerStateStore,
} from "./types.js";

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value) && typeof value === "object" && Object.values(value).every(isJsonValue);
}

function emptyDeliveryState(): DeliveryState {
  return { schemaVersion: 2, markers: [], stageReceipts: [] };
}

function validateDeliveryState(value: unknown): DeliveryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Delivery state is not a v2 object");
  }
  const state = value as { schemaVersion?: unknown; markers?: unknown; stageReceipts?: unknown };
  if (state.schemaVersion !== 2 || !Array.isArray(state.markers) || !Array.isArray(state.stageReceipts)) {
    throw new Error("Delivery state is not a v2 snapshot");
  }
  if (state.markers.some((marker) => !marker || typeof marker !== "object" || Array.isArray(marker) ||
    !("kind" in marker) || typeof marker.kind !== "string" || !("body" in marker) || typeof marker.body !== "string" ||
    !("createdAt" in marker) || typeof marker.createdAt !== "string")) {
    throw new Error("Delivery state contains an invalid marker");
  }
  if (state.stageReceipts.some((receipt) => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      !("stageId" in receipt) || typeof receipt.stageId !== "string" ||
      !("target" in receipt) || typeof receipt.target !== "string" ||
      !("outcome" in receipt) || !["passed", "blocked", "parked", "not-applicable"].includes(String(receipt.outcome)) ||
      !("reason" in receipt) || typeof receipt.reason !== "string" ||
      !("criteriaRevision" in receipt) || typeof receipt.criteriaRevision !== "string" ||
      !("deployed" in receipt) || !Array.isArray(receipt.deployed) ||
      !("criteria" in receipt) || !Array.isArray(receipt.criteria)) return true;
    const invalidDeployed = receipt.deployed.some((item) => !item || typeof item !== "object" || Array.isArray(item) ||
      !("repo" in item) || typeof item.repo !== "string" || !("sha" in item) || typeof item.sha !== "string");
    const invalidCriteria = receipt.criteria.some((item) => !item || typeof item !== "object" || Array.isArray(item) ||
      !("id" in item) || typeof item.id !== "string" || !("outcome" in item) ||
      !["verified", "blocked"].includes(String(item.outcome)) || !("evidence" in item) ||
      !Array.isArray(item.evidence) || item.evidence.some((evidence) => typeof evidence !== "string"));
    return invalidDeployed || invalidCriteria;
  })) throw new Error("Delivery state contains an invalid stage receipt");
  return value as DeliveryState;
}

function stateComment(body: string): DeliveryState | null {
  const match = body.match(/^<!-- delivery-loop-state:v2:([A-Za-z0-9_-]+) -->$/);
  if (!match) {
    if (body.startsWith("<!-- delivery-loop-state:v2:")) throw new Error("Delivery state comment is malformed");
    return null;
  }
  const encoded = match[1]!;
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(json, "utf8").toString("base64url") !== encoded) {
    throw new Error("Delivery state comment is malformed");
  }
  try {
    return validateDeliveryState(JSON.parse(json));
  } catch {
    throw new Error("Delivery state comment is invalid");
  }
}

function commentStateStore(
  commentsFor: (identifier: string) => Promise<TicketComment[]>,
  addComment: (identifier: string, body: string) => Promise<void>,
): TrackerStateStore {
  return {
    async readDeliveryState(identifier) {
      const comments = await commentsFor(identifier);
      for (let index = comments.length - 1; index >= 0; index -= 1) {
        const state = stateComment(comments[index]!.body);
        if (state) return state;
      }
      return emptyDeliveryState();
    },
    async writeDeliveryState(identifier, value) {
      const state = validateDeliveryState(value);
      const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
      await addComment(identifier, `<!-- delivery-loop-state:v2:${encoded} -->`);
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function criteriaRevision(input: {
  title: string;
  description: string;
  issueType: string | null;
  issueTypeIdentity?: string | null;
  fieldValues: Record<string, JsonValue>;
  links: unknown[];
  attachments: TicketAttachment[];
}): string {
  const links = input.links.map(canonicalJson).sort();
  const attachments = input.attachments
    .map(({ id, filename, mimeType }) => ({ id, filename, mimeType }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const content = {
    title: normalizeText(input.title),
    description: normalizeText(input.description),
    issueType: input.issueType,
    issueTypeIdentity: input.issueTypeIdentity ?? null,
    fields: input.fieldValues,
    links,
    attachments,
  };
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function jsonField(fields: Record<string, unknown>, name: string): JsonValue {
  if (!Object.prototype.hasOwnProperty.call(fields, name)) throw new Error(`Jira issue is missing configured field ${name}`);
  const value = fields[name];
  if (!isJsonValue(value)) throw new Error(`Jira configured field ${name} is not JSON`);
  return value;
}

function jiraText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(jiraText).join("");
  const node = value as Record<string, unknown>;
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  const content = Array.isArray(node.content) ? node.content.map(jiraText).join("") : "";
  return ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(String(node.type))
    ? `${content}\n`
    : content;
}

function jiraFieldRecord(fields: Record<string, unknown>, id: string): Record<string, JsonValue> {
  return { [id]: jsonField(fields, id) };
}

function jiraApiBase(config: JiraConfig): string {
  const base = new URL(config.apiBaseUrl);
  if (base.protocol !== "https:" || !base.host || base.username || base.password || base.search || base.hash) {
    throw new Error("Jira apiBaseUrl must be an HTTPS URL without credentials, query, or fragment");
  }
  return base.toString().replace(/\/$/, "");
}
type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  state?: { name: string };
  assignee?: { id: string } | null;
  project?: { name: string } | null;
  labels?: { nodes: { name: string }[] };
  inverseRelations?: {
    nodes: {
      type: string;
      issue?: { identifier: string; state?: { name: string } };
    }[];
  };
  comments?: { nodes: { body: string; createdAt?: string }[] };
  attachments?: { nodes: { url?: string | null; title?: string | null }[] };
};

export function linearTracker(opts: {
  apiKey: string;
  team: string;
  intakeState: string;
  fetch?: FetchLike;
  credentialNote?: CredentialNoteFn;
}): TrackerAdapter & LinearProgramTracker {
  const fetchImpl = opts.fetch ?? fetch;

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await credentialFetch(
      "linear",
      "linear-graphql",
      () =>
        fetchImpl("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            Authorization: opts.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
        }),
      opts.credentialNote,
    );
    if (!response.ok) {
      throw new Error(`Linear failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    return json.data as T;
  }

  function toTicket(issue: LinearIssue): Ticket {
    const comments = [...(issue.comments?.nodes ?? [])]
      .sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""))
      .map((c) => ({ body: c.body, createdAt: c.createdAt }));
    const body = issue.description ?? "";
    const blockedBy = (issue.inverseRelations?.nodes ?? [])
      .filter((rel) => rel.type === "blocks" && rel.issue)
      .map((rel) => ({
        identifier: rel.issue!.identifier,
        stateName: rel.issue!.state?.name ?? "",
      }));
    const attachments: TicketAttachment[] = [];
    const fieldValues: Record<string, JsonValue> = {};
    const urls = [
      ...figmaUrlsFromText(body),
      ...comments.flatMap((comment) => figmaUrlsFromText(comment.body)),
      ...(issue.attachments?.nodes ?? []).flatMap((attachment) =>
        attachment.url ? figmaUrlsFromText(attachment.url) : [],
      ),
    ];
    const figmaUrls: string[] = [];
    for (const url of urls) {
      if (!figmaUrls.includes(url)) figmaUrls.push(url);
    }
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      body,
      stateName: issue.state?.name ?? "",
      labels: (issue.labels?.nodes ?? []).map((l) => l.name),
      issueType: null,
      assigneeId: issue.assignee?.id ?? null,
      fieldValues,
      attachments,
      criteriaRevision: criteriaRevision({
        title: issue.title,
        description: body,
        issueType: null,
        fieldValues,
        links: blockedBy,
        attachments,
      }),
      projectName: issue.project?.name,
      blockedBy,
      comments,
      figmaUrls,
    };
  }

  const issueFields = `
    id identifier title description
    state { name }
    assignee { id }
    project { name }
    labels { nodes { name } }
    comments { nodes { body createdAt } }
    attachments { nodes { url title } }
    inverseRelations { nodes { type issue { identifier state { name } } } }
  `;

  async function fetchTicket(identifier: string): Promise<Ticket> {
    const number = Number(identifier.split("-").pop());
    const data = await gql<{ issues: { nodes: LinearIssue[] } }>(
      `query($team: String!, $number: Float!) {
        issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
          nodes { ${issueFields} }
        }
      }`,
      { team: opts.team, number },
    );
    const issue = data.issues.nodes[0];
    if (!issue) throw new Error(`Linear issue not found: ${identifier}`);
    return toTicket(issue);
  }

  async function createComment(identifier: string, body: string): Promise<void> {
    const ticket = await fetchTicket(identifier);
    await gql(
      `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`,
      { id: ticket.id, body },
    );
  }

  const stateStore = commentStateStore(
    async (identifier) => (await fetchTicket(identifier)).comments,
    createComment,
  );

  return {
    kind: "linear",
    stateStore,
    async listIntake(filter?: { project?: string }) {
      const projectFilter = filter?.project
        ? `, project: { name: { eq: ${JSON.stringify(filter.project)} } }`
        : "";
      const data = await gql<{ issues: { nodes: LinearIssue[] } }>(
        `query($team: String!, $state: String!) {
          issues(filter: { team: { key: { eq: $team } }, state: { name: { eq: $state } }${projectFilter} }, first: 50) {
            nodes { ${issueFields} }
          }
        }`,
        { team: opts.team, state: opts.intakeState },
      );
      return data.issues.nodes.map(toTicket);
    },
    get: fetchTicket,
    comment: createComment,
    async setState(identifier, state, _expectedCriteriaRevision) {
      const ticket = await this.get(identifier);
      const data = await gql<{ workflowStates: { nodes: { id: string; name: string }[] } }>(
        `query($team: String!) { workflowStates(filter: { team: { key: { eq: $team } } }) { nodes { id name } } }`,
        { team: opts.team },
      );
      const match = data.workflowStates.nodes.find(
        (s) => s.name.toLowerCase() === state.toLowerCase(),
      );
      if (!match) throw new Error(`Linear state not found: ${state}`);
      await gql(
        `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
        { id: ticket.id, stateId: match.id },
      );
    },
    async addLabel(identifier, label) {
      const ticket = await this.get(identifier);
      const teamData = await gql<{ teams: { nodes: { id: string }[] } }>(
        `query($team: String!) { teams(filter: { key: { eq: $team } }) { nodes { id } } }`,
        { team: opts.team },
      );
      const teamId = teamData.teams.nodes[0]?.id;
      if (!teamId) throw new Error(`Linear team not found: ${opts.team}`);
      const existing = await gql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(
        `query($name: String!, $teamId: ID!) {
          issueLabels(filter: { name: { eqIgnoreCase: $name }, team: { id: { eq: $teamId } } }) {
            nodes { id name }
          }
        }`,
        { name: label, teamId },
      );
      let labelId = existing.issueLabels.nodes[0]?.id;
      if (!labelId) {
        const created = await gql<{ issueLabelCreate: { issueLabel: { id: string } | null } }>(
          `mutation($name: String!, $teamId: String!) {
            issueLabelCreate(input: { name: $name, teamId: $teamId }) { issueLabel { id } }
          }`,
          { name: label, teamId },
        );
        labelId = created.issueLabelCreate.issueLabel?.id;
      }
      if (!labelId) throw new Error(`Linear label was not created: ${label}`);
      const current = await gql<{ issue: { labels: { nodes: { id: string }[] } } }>(
        `query($id: String!) { issue(id: $id) { labels { nodes { id } } } }`,
        { id: ticket.id },
      );
      const labelIds = current.issue.labels.nodes.map((item) => item.id);
      if (!labelIds.includes(labelId)) labelIds.push(labelId);
      await gql(
        `mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
        }`,
        { id: ticket.id, labelIds },
      );
    },
    async removeLabel(identifier, label) {
      const ticket = await this.get(identifier);
      const teamData = await gql<{ teams: { nodes: { id: string }[] } }>(
        `query($team: String!) { teams(filter: { key: { eq: $team } }) { nodes { id } } }`,
        { team: opts.team },
      );
      const teamId = teamData.teams.nodes[0]?.id;
      if (!teamId) throw new Error(`Linear team not found: ${opts.team}`);
      const existing = await gql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(
        `query($name: String!, $teamId: ID!) {
          issueLabels(filter: { name: { eqIgnoreCase: $name }, team: { id: { eq: $teamId } } }) {
            nodes { id name }
          }
        }`,
        { name: label, teamId },
      );
      const labelId = existing.issueLabels.nodes[0]?.id;
      if (!labelId) return;
      const current = await gql<{ issue: { labels: { nodes: { id: string }[] } } }>(
        `query($id: String!) { issue(id: $id) { labels { nodes { id } } } }`,
        { id: ticket.id },
      );
      const labelIds = current.issue.labels.nodes.map((item) => item.id).filter((id) => id !== labelId);
      await gql(
        `mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
        }`,
        { id: ticket.id, labelIds },
      );
    },
    projectSnapshot(name) {
      return linearProjectSnapshot(gql, name);
    },
  };
}

async function linearProjectSnapshot(
  gql: <T>(query: string, variables: Record<string, unknown>) => Promise<T>,
  name: string,
): Promise<LinearProgramSnapshot> {
  const query = name.trim();
  if (!query) throw new Error("Empty project name");
  const found = await gql<{ projects: { nodes: { id: string; name: string; url: string }[] } }>(
    `query ($filter: ProjectFilter) {
      projects(filter: $filter, first: 25) { nodes { id name url } }
    }`,
    { filter: { name: { eqIgnoreCase: query } } },
  );
  const exact = found.projects.nodes.filter(
    (project) => project.name.toLowerCase() === query.toLowerCase(),
  );
  const project = exact.length === 1 ? exact[0] : found.projects.nodes.length === 1 ? found.projects.nodes[0] : null;
  if (!project) {
    const names = found.projects.nodes.map((item) => item.name).join(", ");
    throw new Error(names ? `Ambiguous or missing project "${query}": ${names}` : `Linear project not found: "${query}"`);
  }
  const meta = await gql<{
    project: {
      id: string;
      name: string;
      url: string;
      projectMilestones: { nodes: { id: string; name: string; description: string | null; sortOrder: number }[] };
    } | null;
  }>(
    `query ($id: String!) {
      project(id: $id) {
        id name url
        projectMilestones(first: 50) { nodes { id name description sortOrder } }
      }
    }`,
    { id: project.id },
  );
  if (!meta.project) throw new Error(`Linear project disappeared: ${project.id}`);

  type IssueNode = {
    identifier: string;
    labels: { nodes: { name: string }[] };
    state: { name: string } | null;
    projectMilestone: { id: string } | null;
    inverseRelations: {
      nodes: { id?: string; type: string; issue: { identifier: string; state: { name: string } | null } }[];
    };
  };
  const issueNodes: IssueNode[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await gql<{
      issues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    }>(
      `query ($filter: IssueFilter, $after: String) {
        issues(filter: $filter, first: 100, after: $after) {
          nodes {
            identifier
            labels { nodes { name } }
            state { name }
            projectMilestone { id }
            inverseRelations { nodes { id type issue { identifier state { name } } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter: { project: { id: { eq: project.id } } }, after },
    );
    issueNodes.push(...page.issues.nodes);
    if (!page.issues.pageInfo.hasNextPage) break;
    after = page.issues.pageInfo.endCursor;
  }

  return {
    projectId: meta.project.id,
    projectName: meta.project.name,
    projectUrl: meta.project.url,
    milestones: meta.project.projectMilestones.nodes.map((milestone) => ({
      id: milestone.id,
      name: milestone.name,
      description: milestone.description,
      sortOrder: milestone.sortOrder,
    })),
    issues: issueNodes.map((issue) => ({
      identifier: issue.identifier,
      stateName: issue.state?.name ?? "",
      labels: issue.labels.nodes.map((label) => label.name),
      milestoneId: issue.projectMilestone?.id ?? null,
      blockedBy: blockersFrom(issue.inverseRelations?.nodes),
    })),
  };
}

function blockersFrom(
  nodes: { id?: string; type: string; issue: { identifier: string; state: { name: string } | null } }[] | undefined,
): IssueBlocker[] {
  const out: IssueBlocker[] = [];
  const seen = new Set<string>();
  for (const node of nodes ?? []) {
    if (node.type.trim().toLowerCase() !== "blocks") continue;
    const identifier = node.issue?.identifier?.trim();
    if (!identifier) continue;
    const key = identifier.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      identifier,
      stateName: node.issue.state?.name ?? "",
      relationId: node.id?.trim() || undefined,
    });
  }
  return out;
}

export function githubIssuesTracker(opts: {
  token: string;
  repo: string;
  intakeLabel: string;
  fetch?: FetchLike;
  credentialNote?: CredentialNoteFn;
  /** `mint` when the runner identity is mint. The token value is not written. */
  slot?: "mint" | "gh-token";
}): TrackerAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  async function api(path: string, init?: RequestInit): Promise<unknown> {
    const response = await credentialFetch(
      opts.slot ?? "gh-token",
      githubEndpointClass(path),
      () =>
        fetchImpl(`https://api.github.com${path}`, {
          ...init,
          headers: { ...headers, ...(init?.headers ?? {}) },
        }),
      opts.credentialNote,
    );
    if (!response.ok) {
      throw new Error(`GitHub issues ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  async function readComments(number: string | number): Promise<{ id: string; body: string; created_at?: string }[]> {
    const comments: { id: string; body: string; created_at?: string }[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page += 1) {
      const rows = await api(`/repos/${opts.repo}/issues/${number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error("GitHub issue comments pagination returned an invalid page");
      let advanced = false;
      for (const row of rows) {
        if (!row || typeof row !== "object" || !("id" in row) ||
          (typeof row.id !== "string" && typeof row.id !== "number") ||
          !("body" in row) || typeof row.body !== "string") {
          throw new Error("GitHub issue comments pagination returned an invalid comment");
        }
        const id = String(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        advanced = true;
        comments.push({
          id,
          body: row.body,
          created_at: "created_at" in row && typeof row.created_at === "string" ? row.created_at : undefined,
        });
      }
      if (rows.length < 100) return comments;
      if (!advanced) throw new Error("GitHub issue comments pagination did not advance");
    }
  }
  async function toTicket(issue: {
    number: number;
    title: string;
    body: string | null;
    labels: { name: string }[];
    state: string;
    assignee?: { id: number } | null;
  }): Promise<Ticket> {
    const comments = await readComments(issue.number);
    const blockedBy = [...(issue.body ?? "").matchAll(/blocked by ([A-Za-z0-9]+-\d+)/gi)].map(
      (match) => ({ identifier: match[1]!, stateName: "unknown" }),
    );
    const commentRows = comments
      .sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""))
      .map((comment) => ({ body: comment.body, createdAt: comment.created_at }));
    const body = issue.body ?? "";
    const fieldValues: Record<string, JsonValue> = {};
    const attachments: TicketAttachment[] = [];
    const figmaUrls = [
      ...figmaUrlsFromText(body),
      ...commentRows.flatMap((comment) => figmaUrlsFromText(comment.body)),
    ];
    return {
      id: String(issue.number),
      identifier: `${opts.repo.split("/")[1]}-${issue.number}`,
      title: issue.title,
      body,
      stateName: issue.labels.map((label) => label.name).find((name) => name.startsWith("status:"))?.slice(7)
        ?? (issue.state === "open" ? opts.intakeLabel : "closed"),
      labels: issue.labels.map((label) => label.name),
      issueType: null,
      assigneeId: issue.assignee ? String(issue.assignee.id) : null,
      fieldValues,
      attachments,
      criteriaRevision: criteriaRevision({
        title: issue.title,
        description: body,
        issueType: null,
        fieldValues,
        links: blockedBy,
        attachments,
      }),
      blockedBy,
      comments: commentRows,
      figmaUrls,
    };
  }

  async function fetchTicket(identifier: string): Promise<Ticket> {
    const number = identifier.split("-").pop()!;
    const issue = (await api(`/repos/${opts.repo}/issues/${number}`)) as {
      number: number;
      title: string;
      body: string | null;
      labels: { name: string }[];
      state: string;
      assignee?: { id: number } | null;
    };
    return toTicket(issue);
  }

  async function createComment(identifier: string, body: string): Promise<void> {
    const number = identifier.split("-").pop()!;
    await api(`/repos/${opts.repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  const stateStore = commentStateStore(
    async (identifier) => (await fetchTicket(identifier)).comments,
    createComment,
  );

  return {
    kind: "github",
    stateStore,
    async listIntake() {
      const issues = (await api(
        `/repos/${opts.repo}/issues?state=open&labels=${encodeURIComponent(opts.intakeLabel)}`,
      )) as { number: number; title: string; body: string | null; labels: { name: string }[]; state: string }[];
      return Promise.all(issues.filter((i) => !("pull_request" in i)).map((i) => toTicket(i)));
    },
    get: fetchTicket,
    comment: createComment,
    async setState(identifier, state, _expectedCriteriaRevision) {
      const number = identifier.split("-").pop();
      const issue = await this.get(identifier);
      const labels = issue.labels.filter((l) => !l.startsWith("status:"));
      labels.push(`status:${state}`);
      await api(`/repos/${opts.repo}/issues/${number}`, {
        method: "PATCH",
        body: JSON.stringify({
          labels,
          state: state.toLowerCase().includes("prod") ? "closed" : "open",
        }),
      });
    },
    async addLabel(identifier, label) {
      const number = identifier.split("-").pop();
      await api(`/repos/${opts.repo}/issues/${number}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [label] }),
      });
    },
    async removeLabel(identifier, label) {
      const number = identifier.split("-").pop();
      await api(`/repos/${opts.repo}/issues/${number}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE",
      });
    },
  };
}

const JIRA_STATE_PROPERTY = "delivery-loop.state.v2";

export function jiraTracker(opts: JiraConfig & {
  fetch?: FetchLike;
  credentialNote?: CredentialNoteFn;
}): TrackerAdapter {
  const baseUrl = jiraApiBase(opts);
  const authHeader = process.env[opts.authHeaderEnv];
  if (!authHeader?.trim()) throw new Error(`${opts.authHeaderEnv} is required`);
  const fetchImpl = opts.fetch ?? fetch;
  const headers = {
    Authorization: authHeader,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const fields = ["summary", "description", "issuetype", "assignee", "status", "labels", "issuelinks", "attachment", opts.approvalFieldId];

  async function api(path: string, init?: RequestInit): Promise<unknown> {
    const response = await credentialFetch(
      "jira",
      "jira-rest",
      () => fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers ?? {}) },
      }),
      opts.credentialNote,
    );
    if (!response.ok) throw new Error(`Jira REST request failed: ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  }

  function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Jira issue is missing ${label}`);
    }
    return value as Record<string, unknown>;
  }

  function text(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Jira issue is missing ${label}`);
    return value;
  }

  function list(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`Jira issue is missing ${label}`);
    return value;
  }

  function issueKey(issue: unknown): string {
    return text(object(issue, "issue data").key, "issue key");
  }

  async function fetchIssue(identifier: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ fields: fields.join(",") });
    return object(await api(`/rest/api/3/issue/${encodeURIComponent(identifier)}?${query}`), "issue data");
  }

  async function readComments(identifier: string): Promise<TicketComment[]> {
    const comments: TicketComment[] = [];
    let startAt = 0;
    for (;;) {
      const page = object(await api(
        `/rest/api/3/issue/${encodeURIComponent(identifier)}/comment?startAt=${startAt}&maxResults=100`,
      ), "comment page");
      const rows = list(page.comments, "comment list");
      if (typeof page.startAt !== "number" || !Number.isInteger(page.startAt) || page.startAt !== startAt ||
        typeof page.total !== "number" || !Number.isInteger(page.total) || page.total < 0) {
        throw new Error("Jira comments pagination returned invalid page metadata");
      }
      for (const row of rows) {
        const comment = object(row, "comment");
        if (!Object.prototype.hasOwnProperty.call(comment, "body")) throw new Error("Jira comment is missing body");
        comments.push({
          body: jiraText(comment.body),
          createdAt: typeof comment.created === "string" ? comment.created : undefined,
        });
      }
      if (startAt + rows.length >= page.total) {
        comments.sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
        return comments;
      }
      if (rows.length === 0) throw new Error("Jira comments pagination did not advance");
      startAt += rows.length;
    }
  }

  function toTicket(issue: Record<string, unknown>, comments: TicketComment[]): Ticket {
    const key = issueKey(issue);
    const id = text(issue.id, "issue ID");
    const issueFields = object(issue.fields, "issue fields");
    if (!Object.prototype.hasOwnProperty.call(issueFields, "description")) {
      throw new Error("Jira issue is missing description field");
    }
    const title = text(issueFields.summary, "summary");
    const body = jiraText(issueFields.description);
    const issueTypeField = object(issueFields.issuetype, "issue type");
    const issueType = text(issueTypeField.name, "issue type name");
    const issueTypeId = text(issueTypeField.id, "issue type ID");
    const stateName = text(object(issueFields.status, "status").name, "status name");
    if (!Object.prototype.hasOwnProperty.call(issueFields, "assignee")) {
      throw new Error("Jira issue is missing assignee field");
    }
    const assignee = issueFields.assignee === null ? null : object(issueFields.assignee, "assignee");
    const assigneeValue = assignee && [assignee.accountId, assignee.key, assignee.name, assignee.id]
      .find((value) => typeof value === "string" || typeof value === "number");
    if (assignee && assigneeValue === undefined) throw new Error("Jira assignee is missing an identifier");
    const labels = list(issueFields.labels, "labels").map((label) => text(label, "label"));
    const approval = jiraFieldRecord(issueFields, opts.approvalFieldId);
    const attachments: TicketAttachment[] = list(issueFields.attachment, "attachments").map((value) => {
      const attachment = object(value, "attachment metadata");
      const rawId = attachment.id;
      if (typeof rawId !== "string" && typeof rawId !== "number") throw new Error("Jira attachment is missing ID");
      return {
        id: String(rawId),
        filename: text(attachment.filename, "attachment filename"),
        mimeType: text(attachment.mimeType, "attachment MIME type"),
        sourceUrl: text(attachment.content, "attachment source URL"),
      };
    });
    const links: JsonValue[] = [];
    const blockedBy: Ticket["blockedBy"] = [];
    const seenBlockers = new Set<string>();
    for (const value of list(issueFields.issuelinks, "issue links")) {
      const link = object(value, "issue link");
      const rawId = link.id;
      if (typeof rawId !== "string" && typeof rawId !== "number") throw new Error("Jira issue link is missing ID");
      const type = object(link.type, "issue link type");
      const typeName = text(type.name, "issue link type name");
      const inward = text(type.inward, "inward link name");
      const outward = text(type.outward, "outward link name");
      const inwardIssue = link.inwardIssue === undefined ? null : object(link.inwardIssue, "inward linked issue");
      const outwardIssue = link.outwardIssue === undefined ? null : object(link.outwardIssue, "outward linked issue");
      if (Boolean(inwardIssue) === Boolean(outwardIssue)) throw new Error("Jira issue link has ambiguous direction");
      const direction = inwardIssue ? "inward" : "outward";
      const linkedIssue = inwardIssue ?? outwardIssue!;
      const linkedKey = text(linkedIssue.key, "linked issue key");
      const relation = direction === "inward" ? inward : outward;
      links.push({
        id: String(rawId),
        type: typeName,
        direction,
        relation,
        issueKey: linkedKey,
      });
      if (["is blocked by", "blocked by"].includes(relation.trim().toLowerCase())) {
        const linkedFields = object(linkedIssue.fields, "blocking issue fields");
        const blockerStatus = text(object(linkedFields.status, "blocking issue status").name, "blocking issue status name");
        if (!seenBlockers.has(linkedKey)) {
          seenBlockers.add(linkedKey);
          blockedBy.push({ identifier: linkedKey, stateName: blockerStatus });
        }
      }
    }
    return {
      id,
      identifier: key,
      title,
      body,
      stateName,
      labels,
      issueType,
      assigneeId: assigneeValue === undefined ? null : String(assigneeValue),
      fieldValues: approval,
      attachments,
      criteriaRevision: criteriaRevision({
        title,
        description: body,
        issueType,
        issueTypeIdentity: issueTypeId,
        fieldValues: approval,
        links,
        attachments,
      }),
      blockedBy,
      comments,
    };
  }

  async function get(identifier: string): Promise<Ticket> {
    const issue = await fetchIssue(identifier);
    return toTicket(issue, await readComments(issueKey(issue)));
  }

  async function listIntake(): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    const seenIssues = new Set<string>();
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;
    for (;;) {
      const page = object(await api("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql: opts.intakeJql,
          maxResults: 100,
          fields,
          ...(nextPageToken ? { nextPageToken } : {}),
        }),
      }), "JQL page");
      const issues = list(page.issues, "JQL results");
      if (typeof page.isLast !== "boolean") throw new Error("Jira JQL pagination is missing isLast");
      for (const issue of issues) {
        const issueRow = object(issue, "JQL issue");
        const key = issueKey(issueRow);
        if (seenIssues.has(key)) continue;
        seenIssues.add(key);
        tickets.push(toTicket(issueRow, await readComments(key)));
      }
      if (page.isLast) return tickets;
      if (typeof page.nextPageToken !== "string" || !page.nextPageToken || seenTokens.has(page.nextPageToken)) {
        throw new Error("Jira JQL pagination did not advance");
      }
      nextPageToken = page.nextPageToken;
      seenTokens.add(nextPageToken);
    }
  }

  const stateStore: TrackerStateStore = {
    async readDeliveryState(identifier) {
      const issuePath = `/rest/api/3/issue/${encodeURIComponent(identifier)}/properties`;
      const result = object(await api(issuePath), "issue properties");
      const keys = list(result.keys, "issue property keys").map((row) =>
        text(object(row, "issue property key").key, "issue property key"),
      );
      if (!keys.includes(JIRA_STATE_PROPERTY)) return emptyDeliveryState();
      const property = object(await api(`${issuePath}/${encodeURIComponent(JIRA_STATE_PROPERTY)}`), "issue property");
      if (!Object.prototype.hasOwnProperty.call(property, "value")) throw new Error("Jira delivery-state property is missing value");
      return validateDeliveryState(property.value);
    },
    async writeDeliveryState(identifier, value) {
      const state = validateDeliveryState(value);
      await api(
        `/rest/api/3/issue/${encodeURIComponent(identifier)}/properties/${encodeURIComponent(JIRA_STATE_PROPERTY)}`,
        { method: "PUT", body: JSON.stringify(state) },
      );
    },
  };

  return {
    kind: "jira",
    stateStore,
    listIntake,
    get,
    async comment(identifier, body) {
      const content = body.split("\n").flatMap((line, index) => [
        ...(index ? [{ type: "hardBreak" }] : []),
        ...(line ? [{ type: "text", text: line }] : []),
      ]);
      await api(`/rest/api/3/issue/${encodeURIComponent(identifier)}/comment`, {
        method: "POST",
        body: JSON.stringify({
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content }] },
        }),
      });
    },
    async setState(identifier, state, expectedCriteriaRevision) {
      if (typeof expectedCriteriaRevision !== "string" || !expectedCriteriaRevision.trim()) {
        throw new Error("Jira status transition requires expected criteriaRevision");
      }
      const path = `/rest/api/3/issue/${encodeURIComponent(identifier)}/transitions`;
      const transitions = object(await api(`${path}?expand=transitions.fields`), "transitions");
      const available = list(transitions.transitions, "transitions list");
      const matches = available.filter((value) => object(value, "transition").to &&
        object(object(value, "transition").to, "transition target").name === state);
      if (matches.length !== 1) {
        throw new Error(matches.length ? `Jira status transition to ${state} is ambiguous` : `Jira status transition to ${state} is unavailable`);
      }
      const transition = object(matches[0], "transition");
      const transitionId = transition.id;
      if (typeof transitionId !== "string" && typeof transitionId !== "number") {
        throw new Error("Jira transition is missing ID");
      }
      const current = toTicket(await fetchIssue(identifier), []);
      if (current.criteriaRevision !== expectedCriteriaRevision) {
        throw new Error("Jira criteria revision changed; refusing status transition");
      }
      await api(path, {
        method: "POST",
        body: JSON.stringify({ transition: { id: String(transitionId) } }),
      });
    },
    async addLabel(identifier, label) {
      await api(`/rest/api/3/issue/${encodeURIComponent(identifier)}`, {
        method: "PUT",
        body: JSON.stringify({ update: { labels: [{ add: label }] } }),
      });
    },
    async removeLabel(identifier, label) {
      await api(`/rest/api/3/issue/${encodeURIComponent(identifier)}`, {
        method: "PUT",
        body: JSON.stringify({ update: { labels: [{ remove: label }] } }),
      });
    },
  };
}
