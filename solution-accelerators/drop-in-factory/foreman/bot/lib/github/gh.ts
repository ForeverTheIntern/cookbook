/**
 * The only two `gh` calls: the issue timeline (who added a gate label, and
 * when) and the Deployments GraphQL connection for DORA. Everything else is
 * REST in ./rest.ts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tokenOf, type GitHub } from "./rest.ts";

const run = promisify(execFile);

async function gh(token: string, args: string[]): Promise<any> {
  const { stdout } = await run("gh", args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: token }, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export interface LabelEvent {
  id: number;
  label: string;
  login: string;
  at: string;
}

/** Every `labeled` event on an issue or pull request, oldest first. */
export async function labelEvents(github: GitHub, number: number): Promise<LabelEvent[]> {
  const pages = await gh(await tokenOf(github), ["api", "--paginate", "--slurp", `repos/${github.repo}/issues/${number}/timeline?per_page=100`]);
  return (pages as any[][])
    .flat()
    .filter((e) => e.event === "labeled")
    .map((e) => ({ id: e.id, label: e.label.name, login: e.actor.login, at: e.created_at }));
}

export interface Deployment {
  id: string;
  sha: string;
  at: string;
}

/** Successful deployments to one environment since a date, newest first. */
export async function deployments(github: GitHub, environment: string, since: string): Promise<Deployment[]> {
  const [owner, name] = github.repo.split("/");
  const query = `query($owner:String!,$name:String!,$env:String!){
    repository(owner:$owner,name:$name){
      deployments(environments:[$env], first:100, orderBy:{field:CREATED_AT, direction:DESC}){
        nodes{ id createdAt commitOid latestStatus{ state } }
      }
    }
  }`;
  const data = await gh(await tokenOf(github), ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `env=${environment}`]);
  return data.data.repository.deployments.nodes
    .filter((d: any) => d.latestStatus?.state === "SUCCESS" && d.createdAt >= since)
    .map((d: any) => ({ id: d.id, sha: d.commitOid, at: d.createdAt }));
}
