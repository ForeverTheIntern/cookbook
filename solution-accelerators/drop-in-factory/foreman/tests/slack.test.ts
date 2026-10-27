import assert from "node:assert/strict";
import { test } from "node:test";
import { channelPeople, mentionAllowlist } from "../bot/lib/slack/post.ts";

const users: Record<string, { is_bot: boolean; deleted: boolean }> = {
  U0PERSON1: { is_bot: false, deleted: false },
  U0FOREMAN: { is_bot: true, deleted: false },
  U0PERSON2: { is_bot: false, deleted: false },
  U0GONE: { is_bot: false, deleted: true },
  USLACKBOT: { is_bot: false, deleted: false },
};

test("slack: channel people are the members who are neither bots nor deactivated, across pages", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: { body: URLSearchParams; headers: Record<string, string> }) => {
    const method = url.split("/").at(-1)!;
    calls.push(method);
    assert.equal(init.headers.authorization, "Bearer xoxb-test");
    if (method === "conversations.members") {
      assert.equal(init.body.get("channel"), "C0FACTORY");
      const first = init.body.get("cursor") === null;
      return Response.json(first
        ? { ok: true, members: ["U0PERSON1", "U0FOREMAN", "U0GONE"], response_metadata: { next_cursor: "page2" } }
        : { ok: true, members: ["U0PERSON2", "USLACKBOT"], response_metadata: { next_cursor: "" } });
    }
    const id = init.body.get("user")!;
    return Response.json({ ok: true, user: { id, ...users[id] } });
  });
  assert.deepEqual(await channelPeople({ token: "xoxb-test" }, "C0FACTORY"), ["U0PERSON1", "U0PERSON2"]);
  assert.equal(calls.filter((c) => c === "conversations.members").length, 2);
});

test("slack: a Slack error names the method", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error: "missing_scope" }));
  await assert.rejects(channelPeople({ token: "xoxb-test" }, "C0FACTORY"), /conversations\.members failed: missing_scope/);
});

test("slack: the mention allowlist holds the tester bot and the people, or is left off", () => {
  assert.equal(mentionAllowlist(null, []), undefined);
  assert.deepEqual(mentionAllowlist("B0TESTER", ["U0PERSON1"])?.allowFrom, ["B0TESTER", "U0PERSON1"]);
  assert.deepEqual(mentionAllowlist(null, ["U0PERSON1"])?.allowFrom, ["U0PERSON1"]);
});
