/**
 * Every call the pipeline makes outside the store. `livePorts` wires the real
 * GitHub, Cloud Agents and Slack clients; tests pass fakes with the same shape.
 *
 * GitHub has two identities. Foreman's own posts (notices, reviews, labels,
 * closing) and its reads use the factory identity from `github.identity` in
 * factory.yaml. Words a person wrote in Slack (`relay`) and the issue a Slack
 * request opens (`createIssue`) use the operator's SA_GH_TOKEN.
 */

import * as rest from "../github/rest.ts";
import * as ghcli from "../github/gh.ts";
import * as agents from "../steps/cloud-agent.ts";
import { personName, postMessage, reactionsOn, updateMessage, uploadFile, type Blocks } from "../slack/post.ts";

export interface Ports {
  github: {
    baseSha(): Promise<string>;
    branchSha(branch: string): Promise<string | null>;
    createBranch(branch: string, fromSha: string): Promise<void>;
    deleteBranch(branch: string): Promise<void>;
    readFile(path: string, ref: string): Promise<string | null>;
    changedFiles(base: string, head: string): Promise<string[]>;
    issue(number: number): Promise<rest.Issue>;
    createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }>;
    closeIssue(number: number, reason: rest.CloseReason): Promise<void>;
    addLabel(number: number, label: string): Promise<void>;
    comments(number: number): Promise<rest.Comment[]>;
    /** A factory post; returns its comment id. */
    comment(number: number, body: string): Promise<number>;
    editComment(id: number, body: string): Promise<void>;
    /** A person's words from Slack, posted with the operator's token. */
    relay(number: number, body: string): Promise<void>;
    labelEvents(number: number): Promise<ghcli.LabelEvent[]>;
    pull(number: number): Promise<rest.Pull>;
    pullForBranch(branch: string): Promise<rest.Pull | null>;
    openDraft(branch: string, title: string, body: string): Promise<rest.Pull>;
    markReady(pull: rest.Pull): Promise<void>;
    closePull(number: number): Promise<void>;
    review(number: number, body: string): Promise<void>;
    feedback(number: number, sha: string): Promise<rest.PrFeedback>;
    isApprover(login: string, approvers: string[]): Promise<boolean>;
    recentWork(): Promise<{ number: number; title: string; url: string; state: string; kind: string; labels: string[] }[]>;
  };
  agents: {
    launch(launch: agents.Launch): Promise<agents.AgentState>;
    status(id: string): Promise<agents.AgentState>;
    stop(id: string): Promise<void>;
    /** The agent's walkthrough mp4, or null when it saved none (or it is too big to upload). */
    video(id: string, hint: string | null): Promise<{ name: string; data: Uint8Array } | null>;
  };
  /** null when factory.yaml has no slack block. */
  slack: {
    post(channel: string, text: string, threadTs: string | null, blocks?: Blocks): Promise<string>;
    update(channel: string, ts: string, text: string, blocks?: Blocks): Promise<void>;
    reactions(channel: string, ts: string): Promise<{ name: string; users: string[] }[]>;
    upload(channel: string, threadTs: string, file: { name: string; data: Uint8Array }, text: string, blocks?: Blocks): Promise<void>;
    person(user: string): Promise<string>;
  } | null;
}

export interface LiveInput {
  /** The operator's token (SA_GH_TOKEN). */
  githubToken: string;
  /** Foreman's own identity: the operator's token for `personal`, a bot user's token, or a GitHub App's installation token. */
  factoryToken: string | (() => Promise<string>);
  repo: string;
  base: string;
  cursorApiKey: string;
  slackBotToken: string | null;
}

export function livePorts(input: LiveInput): Ports {
  const gh: rest.GitHub = { token: input.factoryToken, repo: input.repo };
  const operator: rest.GitHub = { token: input.githubToken, repo: input.repo };
  const slack = input.slackBotToken === null ? null : { token: input.slackBotToken };
  return {
    github: {
      baseSha: async () => {
        const sha = await rest.branchSha(gh, input.base);
        if (sha === null) throw new Error(`base branch ${input.base} does not exist on ${input.repo}`);
        return sha;
      },
      branchSha: (branch) => rest.branchSha(gh, branch),
      createBranch: (branch, sha) => rest.createBranch(gh, branch, sha),
      deleteBranch: (branch) => rest.deleteBranch(gh, branch),
      readFile: (path, ref) => rest.readFile(gh, path, ref),
      changedFiles: (base, head) => rest.changedFiles(gh, base, head),
      issue: (n) => rest.getIssue(gh, n),
      createIssue: (title, body, labels) => rest.createIssue(operator, title, body, labels),
      closeIssue: (n, reason) => rest.closeIssue(gh, n, reason),
      addLabel: (n, label) => rest.addLabel(gh, n, label),
      comments: (n) => rest.listComments(gh, n),
      comment: (n, body) => rest.comment(gh, n, body),
      editComment: (id, body) => rest.editComment(gh, id, body),
      relay: async (n, body) => void (await rest.comment(operator, n, body)),
      labelEvents: (n) => ghcli.labelEvents(gh, n),
      pull: (n) => rest.getPull(gh, n),
      pullForBranch: (branch) => rest.pullForBranch(gh, branch),
      openDraft: (branch, title, body) => rest.openDraftPull(gh, branch, input.base, title, body),
      markReady: (pull) => rest.markReady(gh, pull),
      closePull: (n) => rest.closePull(gh, n),
      review: (n, body) => rest.postReview(gh, n, body),
      feedback: (n, sha) => rest.prFeedback(gh, n, sha),
      isApprover: (login, approvers) => rest.isApprover(gh, login, approvers),
      recentWork: () => rest.recentWork(gh),
    },
    agents: {
      launch: (launch) => agents.launchAgent(input.cursorApiKey, launch),
      status: (id) => agents.agentStatus(input.cursorApiKey, id),
      stop: (id) => agents.stopAgent(input.cursorApiKey, id),
      video: (id, hint) => agents.videoArtifact(input.cursorApiKey, id, hint),
    },
    slack: slack === null ? null : {
      post: (channel, text, ts, blocks) => postMessage(slack, channel, text, ts, blocks),
      update: (channel, ts, text, blocks) => updateMessage(slack, channel, ts, text, blocks),
      reactions: (channel, ts) => reactionsOn(slack, channel, ts),
      upload: (channel, ts, file, text, blocks) => uploadFile(slack, channel, ts, file, text, blocks),
      person: (user) => personName(slack, user),
    },
  };
}
