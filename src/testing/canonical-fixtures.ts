import { probeExtension, probeGithub, probeLinearViewer, resolveMintedCredential, type CanonicalCredential } from "../adapters/canonical-path.ts";
import type { CanonicalPath } from "../bots/canonical.ts";
import type { CommitActor } from "../schema/pack.ts";
import type { FetchLike } from "../adapters/types.ts";

export const viewerId = "00000000-0000-4000-8000-000000000001";
export const organizationId = "00000000-0000-4000-8000-000000000002";

export const linearPath: CanonicalPath = {
  api: "linear",
  source: "ref:linear-oauth",
  acquisition: "mint-per-process",
  refresh: "per-process",
  mintCommand: "mint-linear",
  expectedIdentity: "Example Delivery",
  viewerId,
  organizationId,
};

export const openerPath: CanonicalPath = {
  api: "github",
  role: "opener",
  source: "ref:github-opener",
  acquisition: "mint-per-process",
  refresh: "per-process",
  mintCommand: "mint-github-opener",
  identityKind: "user",
  actorRef: "ref:commit-actor",
  allowedPrincipalIds: ["1001"],
};

export const mergerPath: CanonicalPath = {
  api: "github",
  role: "merger",
  source: "ref:github-merger",
  acquisition: "mint-per-process",
  refresh: "per-process",
  mintCommand: "mint-github-merger",
  identityKind: "installation",
  appId: "2001",
  installation: "2002",
  repository: "example/app",
};

export const actors: CommitActor[] = [
  {
    login: "example-owner",
    id: "1001",
    repos: [
      "https://github.com/acme/api",
      "https://github.com/acme/admin-web",
      "https://github.com/example/app",
      "https://github.com/Madmaxme/delivery-loop",
      "acme/api",
      "Madmaxme/delivery-loop",
    ],
  },
];

export function issue(path: CanonicalPath, token: string, env: NodeJS.ProcessEnv = {}): CanonicalCredential {
  return resolveMintedCredential(path, {
    env,
    spawn: () => ({ status: 0, stdout: `${token}\n` }),
  });
}

export function mintCredential(path: CanonicalPath, token: string, env: NodeJS.ProcessEnv = {}): CanonicalCredential {
  return issue(path, token, env);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const healthFetch: FetchLike = async (url, init) => {
  const href = String(url);
  const body = typeof init?.body === "string" ? init.body : "";
  if (body.includes("viewer")) {
    return json({ data: { viewer: { id: viewerId, name: "Example Delivery", organization: { id: organizationId } } } });
  }
  if (href.endsWith("/user")) return json({ id: 1001, login: "example-owner" });
  if (href.includes("/installation")) return json({ id: 2002, app_id: 2001 });
  return json({});
};

export async function readyLinear(token = "k"): Promise<CanonicalCredential> {
  const credential = issue(linearPath, token);
  await probeLinearViewer(credential, healthFetch);
  return credential;
}

export async function readyOpener(token = "opener-token"): Promise<CanonicalCredential> {
  const credential = issue(openerPath, token);
  await probeGithub(credential, healthFetch);
  return credential;
}

export async function readyMerger(token = "merger-token"): Promise<CanonicalCredential> {
  const credential = issue(mergerPath, token);
  await probeGithub(credential, healthFetch);
  return credential;
}

export async function readyExtension(api: string, token = "k"): Promise<CanonicalCredential> {
  const credential = issue(
    {
      api,
      source: `ref:${api}-mint`,
      acquisition: "mint-per-process",
      refresh: "per-process",
      mintCommand: `mint-${api}`,
      healthCommand: `probe-${api}`,
    },
    token,
  );
  await probeExtension(credential, () => ({ status: 0, stdout: '{"id":"worker-1"}\n' }), {});
  return credential;
}
