import type { FetchLike, Ticket, TrackerAdapter } from "./types.js";

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  state?: { name: string };
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
      blockedBy: (issue.inverseRelations?.nodes ?? [])
        .filter((rel) => rel.type === "blocks" && rel.issue)
        .map((rel) => ({
          identifier: rel.issue!.identifier,
          stateName: rel.issue!.state?.name ?? "",
        })),
      comments: [...(issue.comments?.nodes ?? [])]
        .sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""))
        .map((c) => c.body),
    };
  }

  const issueFields = `
    id identifier title description
    state { name }
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
  };
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
        .map((c) => c.body),
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
  };
}
