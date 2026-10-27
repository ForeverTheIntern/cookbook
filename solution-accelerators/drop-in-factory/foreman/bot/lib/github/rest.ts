/**
 * GitHub REST and GraphQL with fetch. The token is an argument; this file
 * does not read the environment. `gh` is used only in ./gh.ts.
 */

export interface GitHub {
  /** A token, or a function for one that expires (a GitHub App installation token). */
  token: string | (() => Promise<string>);
  repo: string;
}

export const tokenOf = async (gh: GitHub): Promise<string> => (typeof gh.token === "string" ? gh.token : gh.token());

export interface Comment {
  id: number;
  login: string;
  /** Posted by an app or bot account (GitHub's user type Bot). */
  bot: boolean;
  body: string;
  createdAt: string;
  url: string;
}

export interface Pull {
  number: number;
  url: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  mergedBy: string | null;
  headSha: string;
  nodeId: string;
  /** GitHub's mergeable_state: "dirty" means it conflicts with its base. "unknown" while GitHub computes it. */
  mergeableState: string;
}

export async function api(gh: GitHub, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await tokenOf(gh)}`,
      "content-type": "application/json",
      "user-agent": "drop-in-factory",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) throw new Error(`GitHub ${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  return text === "" ? null : JSON.parse(text);
}

export async function branchSha(gh: GitHub, branch: string): Promise<string | null> {
  const ref = await api(gh, "GET", `/repos/${gh.repo}/git/ref/heads/${branch}`);
  return ref === null ? null : ref.object.sha;
}

export async function createBranch(gh: GitHub, branch: string, fromSha: string): Promise<void> {
  await api(gh, "POST", `/repos/${gh.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: fromSha });
}

export async function defaultBranch(gh: GitHub): Promise<string> {
  return (await api(gh, "GET", `/repos/${gh.repo}`)).default_branch;
}

/** A file's text at a ref, or null when the file is not there. */
export async function readFile(gh: GitHub, path: string, ref: string): Promise<string | null> {
  const file = await api(gh, "GET", `/repos/${gh.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (file === null || typeof file.content !== "string") return null;
  return Buffer.from(file.content, "base64").toString("utf8");
}

/** Files changed between two commits. */
export async function changedFiles(gh: GitHub, base: string, head: string): Promise<string[]> {
  const compare = await api(gh, "GET", `/repos/${gh.repo}/compare/${base}...${head}`);
  return (compare.files ?? []).map((f: { filename: string }) => f.filename);
}

export async function deleteBranch(gh: GitHub, branch: string): Promise<void> {
  if ((await branchSha(gh, branch)) === null) return;
  await api(gh, "DELETE", `/repos/${gh.repo}/git/refs/heads/${branch}`);
}

/** The 100 most recently updated issues and pull requests, for Triage to judge. */
export async function recentWork(gh: GitHub): Promise<{ number: number; title: string; url: string; state: string; kind: string; labels: string[] }[]> {
  const rows = await api(gh, "GET", `/repos/${gh.repo}/issues?state=all&sort=updated&per_page=100`);
  return rows.map((r: any) => ({
    number: r.number, title: r.title, url: r.html_url, state: r.state, kind: r.pull_request ? "pr" : "issue", labels: (r.labels ?? []).map((l: { name: string }) => l.name),
  }));
}

export interface Issue {
  title: string;
  body: string;
  url: string;
  state: string;
  labels: string[];
  /** Who closed it, when it is closed. */
  closedBy: string | null;
}

export async function getIssue(gh: GitHub, number: number): Promise<Issue> {
  const issue = await api(gh, "GET", `/repos/${gh.repo}/issues/${number}`);
  return {
    title: issue.title,
    body: issue.body ?? "",
    url: issue.html_url,
    state: issue.state,
    labels: issue.labels.map((l: { name: string }) => l.name),
    closedBy: issue.closed_by?.login ?? null,
  };
}

/** Add a label to an issue or pull request. GitHub creates a label that does not exist yet. */
export async function addLabel(gh: GitHub, number: number, label: string): Promise<void> {
  await api(gh, "POST", `/repos/${gh.repo}/issues/${number}/labels`, { labels: [label] });
}

export async function createIssue(gh: GitHub, title: string, body: string, labels: string[]): Promise<{ number: number; url: string }> {
  const issue = await api(gh, "POST", `/repos/${gh.repo}/issues`, { title, body, labels });
  return { number: issue.number, url: issue.html_url };
}

export type CloseReason = "completed" | "not_planned";

export async function closeIssue(gh: GitHub, number: number, reason: CloseReason): Promise<void> {
  await api(gh, "PATCH", `/repos/${gh.repo}/issues/${number}`, { state: "closed", state_reason: reason });
}

export async function listComments(gh: GitHub, number: number): Promise<Comment[]> {
  const out: Comment[] = [];
  for (let page = 1; ; page += 1) {
    const rows = await api(gh, "GET", `/repos/${gh.repo}/issues/${number}/comments?per_page=100&page=${page}`);
    for (const row of rows) {
      out.push({ id: row.id, login: row.user.login, bot: row.user.type === "Bot", body: row.body ?? "", createdAt: row.created_at, url: row.html_url });
    }
    if (rows.length < 100) return out;
  }
}

/** Returns the new comment's id. */
export async function comment(gh: GitHub, number: number, body: string): Promise<number> {
  return (await api(gh, "POST", `/repos/${gh.repo}/issues/${number}/comments`, { body })).id;
}

export async function editComment(gh: GitHub, id: number, body: string): Promise<void> {
  await api(gh, "PATCH", `/repos/${gh.repo}/issues/comments/${id}`, { body });
}

export async function pullForBranch(gh: GitHub, branch: string): Promise<Pull | null> {
  const owner = gh.repo.split("/")[0];
  const rows = await api(gh, "GET", `/repos/${gh.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  if (rows.length === 0) return null;
  return getPull(gh, rows[0].number);
}

export async function getPull(gh: GitHub, number: number): Promise<Pull> {
  const pr = await api(gh, "GET", `/repos/${gh.repo}/pulls/${number}`);
  return {
    number: pr.number,
    url: pr.html_url,
    draft: pr.draft,
    state: pr.state,
    merged: pr.merged,
    mergedAt: pr.merged_at,
    mergedBy: pr.merged_by?.login ?? null,
    headSha: pr.head.sha,
    nodeId: pr.node_id,
    mergeableState: pr.mergeable_state ?? "unknown",
    body: pr.body ?? "",
  };
}

export async function openDraftPull(gh: GitHub, branch: string, base: string, title: string, body: string): Promise<Pull> {
  const pr = await api(gh, "POST", `/repos/${gh.repo}/pulls`, { head: branch, base, title, body, draft: true });
  return getPull(gh, pr.number);
}

export async function markReady(gh: GitHub, pull: Pull): Promise<void> {
  await api(gh, "POST", "/graphql", {
    query: "mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { isDraft } } }",
    variables: { id: pull.nodeId },
  });
}

export async function closePull(gh: GitHub, number: number): Promise<void> {
  await api(gh, "PATCH", `/repos/${gh.repo}/pulls/${number}`, { state: "closed" });
}

/** A COMMENT review; findings are in the body, so a line outside the diff cannot reject it. */
export async function postReview(gh: GitHub, number: number, body: string): Promise<void> {
  await api(gh, "POST", `/repos/${gh.repo}/pulls/${number}/reviews`, { event: "COMMENT", body });
}

/** Whether `login` may approve: a listed login, or a member of a listed `team:org/slug`. */
export async function isApprover(gh: GitHub, login: string, approvers: string[]): Promise<boolean> {
  if (approvers.includes(login)) return true;
  for (const entry of approvers) {
    if (!entry.startsWith("team:")) continue;
    const [org, slug] = entry.slice(5).split("/");
    const membership = await api(gh, "GET", `/orgs/${org}/teams/${slug}/memberships/${login}`);
    if (membership?.state === "active") return true;
  }
  return false;
}

/** Everything said about a pull request after it opened: reviews, review threads, and the checks on its head. */
export interface PrFeedback {
  reviews: { id: number; login: string; bot: boolean; state: string; body: string; submittedAt: string; commit: string; url: string }[];
  threads: { id: string; resolved: boolean; outdated: boolean; login: string; bot: boolean; path: string; line: number | null; body: string; url: string; createdAt: string }[];
  /** Check runs and commit statuses on `sha`. status is queued, in_progress or completed; conclusion is set once completed. */
  checks: { name: string; status: string; conclusion: string | null; url: string; summary: string }[];
}

export async function prFeedback(gh: GitHub, number: number, sha: string): Promise<PrFeedback> {
  const reviews = ((await api(gh, "GET", `/repos/${gh.repo}/pulls/${number}/reviews?per_page=100`)) ?? []).map((r: any) => ({
    id: r.id, login: r.user?.login ?? "", bot: r.user?.type === "Bot", state: r.state, body: r.body ?? "", submittedAt: r.submitted_at ?? "", commit: r.commit_id ?? "", url: r.html_url ?? "",
  }));
  const [owner, name] = gh.repo.split("/");
  const graph = await api(gh, "POST", "/graphql", {
    query: `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){
      reviewThreads(first:100){ nodes{ id isResolved isOutdated path line comments(first:1){ nodes{ body url createdAt author{ login __typename } } } } } } } }`,
    variables: { owner, name, number },
  });
  const threads = (graph?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((t: any) => {
    const first = t.comments.nodes[0] ?? {};
    return {
      id: t.id, resolved: t.isResolved, outdated: t.isOutdated, path: t.path ?? "", line: t.line ?? null,
      login: first.author?.login ?? "", bot: first.author?.__typename === "Bot", body: first.body ?? "", url: first.url ?? "", createdAt: first.createdAt ?? "",
    };
  });
  const runs = await checkRuns(gh, sha);
  const statuses = (await api(gh, "GET", `/repos/${gh.repo}/commits/${sha}/status`))?.statuses ?? [];
  const checks = [
    ...(runs === "forbidden" ? await checkRollup(gh, sha, number) : runs).map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion ?? null, url: c.html_url ?? c.details_url ?? "", summary: c.output?.title ?? c.output?.summary ?? "" })),
    ...statuses.map((s: any) => ({
      name: s.context, status: s.state === "pending" ? "in_progress" : "completed", conclusion: s.state === "pending" ? null : s.state === "success" ? "success" : "failure", url: s.target_url ?? "", summary: s.description ?? "",
    })),
  ];
  return { reviews, threads, checks };
}

/** Check runs on `sha`, or "forbidden": GitHub gives fine-grained personal tokens no Checks permission. */
async function checkRuns(gh: GitHub, sha: string): Promise<any[] | "forbidden"> {
  try {
    return (await api(gh, "GET", `/repos/${gh.repo}/commits/${sha}/check-runs?per_page=100`))?.check_runs ?? [];
  } catch (err) {
    if (String(err).includes("returned 403")) return "forbidden";
    throw err;
  }
}

/** The commit's combined check state as one check run, which such a token can still read. */
async function checkRollup(gh: GitHub, sha: string, number: number): Promise<any[]> {
  const [owner, name] = gh.repo.split("/");
  const graph = await api(gh, "POST", "/graphql", {
    query: "query($owner:String!,$name:String!,$sha:String!){ repository(owner:$owner,name:$name){ object(expression:$sha){ ... on Commit { statusCheckRollup { state } } } } }",
    variables: { owner, name, sha },
  });
  const state: string | undefined = graph?.data?.repository?.object?.statusCheckRollup?.state;
  if (state === undefined) return [];
  const done = state !== "PENDING" && state !== "EXPECTED";
  return [{
    name: "all checks",
    status: done ? "completed" : "in_progress",
    conclusion: done ? (state === "SUCCESS" ? "success" : "failure") : null,
    html_url: `https://github.com/${gh.repo}/pull/${number}/checks`,
    output: { title: "GitHub's combined check state (this token can't read check runs one by one)" },
  }];
}
