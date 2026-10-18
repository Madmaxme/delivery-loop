import type { IssueBlocker, LinearProgramSnapshot } from "../engine/linear-harness-policy.js";
import type { FetchLike, Ticket, TrackerAdapter } from "./types.js";

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  state?: { name: string };
  project?: { name: string } | null;
  labels?: { nodes: { name: string }[] };
  inverseRelations?: {
    nodes: {
      type: string;
      issue?: { identifier: string; state?: { name: string } };
    }[];
  };
  comments?: { nodes: { body: string; createdAt?: string }[] };
};

export function linearTracker(opts: {
  apiKey: string;
  team: string;
  intakeState: string;
  fetch?: FetchLike;
}): TrackerAdapter {
  const fetchImpl = opts.fetch ?? fetch;

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: opts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
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
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      body: issue.description ?? "",
      stateName: issue.state?.name ?? "",
      labels: (issue.labels?.nodes ?? []).map((l) => l.name),
      projectName: issue.project?.name,
      blockedBy: (issue.inverseRelations?.nodes ?? [])
        .filter((rel) => rel.type === "blocks" && rel.issue)
        .map((rel) => ({
          identifier: rel.issue!.identifier,
          stateName: rel.issue!.state?.name ?? "",
        })),
      comments: [...(issue.comments?.nodes ?? [])]
        .sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""))
        .map((c) => ({ body: c.body, createdAt: c.createdAt })),
    };
  }

  const issueFields = `
    id identifier title description
    state { name }
    project { name }
    labels { nodes { name } }
    comments { nodes { body createdAt } }
    inverseRelations { nodes { type issue { identifier state { name } } } }
  `;

  return {
    kind: "linear",
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
    async get(identifier: string) {
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
    },
    async comment(identifier, body) {
      const ticket = await this.get(identifier);
      await gql(
        `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`,
        { id: ticket.id, body },
      );
    },
    async setState(identifier, state) {
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
      await this.comment(identifier, `label:${label}`);
    },
    async removeLabel(identifier, label) {
      await this.comment(identifier, `unlabel:${label}`);
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
}): TrackerAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  async function api(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(`GitHub issues ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  async function toTicket(issue: {
    number: number;
    title: string;
    body: string | null;
    labels: { name: string }[];
    state: string;
  }): Promise<Ticket> {
    const comments = (await api(
      `/repos/${opts.repo}/issues/${issue.number}/comments`,
    )) as { body: string; created_at?: string }[];
    const blocked = [...(issue.body ?? "").matchAll(/blocked by ([A-Za-z0-9]+-\d+)/gi)].map(
      (m) => m[1],
    );
    return {
      id: String(issue.number),
      identifier: `${opts.repo.split("/")[1]}-${issue.number}`,
      title: issue.title,
      body: issue.body ?? "",
      stateName: issue.labels.map((l) => l.name).find((n) => n.startsWith("status:"))?.slice(7)
        ?? (issue.state === "open" ? opts.intakeLabel : "closed"),
      labels: issue.labels.map((l) => l.name),
      blockedBy: blocked.map((identifier) => ({ identifier, stateName: "unknown" })),
      comments: [...comments]
        .sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""))
        .map((c) => ({ body: c.body, createdAt: c.created_at })),
    };
  }

  return {
    kind: "github",
    async listIntake() {
      const issues = (await api(
        `/repos/${opts.repo}/issues?state=open&labels=${encodeURIComponent(opts.intakeLabel)}`,
      )) as { number: number; title: string; body: string | null; labels: { name: string }[]; state: string }[];
      return Promise.all(issues.filter((i) => !("pull_request" in i)).map((i) => toTicket(i)));
    },
    async get(identifier) {
      const number = identifier.split("-").pop();
      const issue = (await api(`/repos/${opts.repo}/issues/${number}`)) as {
        number: number;
        title: string;
        body: string | null;
        labels: { name: string }[];
        state: string;
      };
      return toTicket(issue);
    },
    async comment(identifier, body) {
      const number = identifier.split("-").pop();
      await api(`/repos/${opts.repo}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },
    async setState(identifier, state) {
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
    async projectSnapshot() {
      return null;
    },
  };
}
