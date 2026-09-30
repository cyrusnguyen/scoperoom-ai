import assert from "node:assert/strict";
import test from "node:test";
import { parseTopic, realtimeTopics } from "../src/features/collaboration/contracts/topics.ts";

const id = "11111111-1111-4111-8111-111111111111";
const epoch = "22222222-2222-4222-8222-222222222222";
const lettered = "abcdefab-abcd-4bcd-8bcd-abcdefabcdef";

test("topics are exact and round-trip through the parser", () => {
  const topics = realtimeTopics(id, epoch);
  assert.deepEqual(topics, { events: `project:${id}:${epoch}:events`, collab: `project:${id}:${epoch}:collab` });
  assert.deepEqual(parseTopic(topics.events), { projectId: id, epoch, purpose: "events" });
  assert.deepEqual(parseTopic(realtimeTopics(lettered, epoch).collab), { projectId: lettered, epoch, purpose: "collab" });
  assert.deepEqual(parseTopic(topics.collab), { projectId: id, epoch, purpose: "collab" });
});

test("the parser rejects anything but a canonical topic", () => {
  const rejected: unknown[] = [
    `project:${id}:${epoch}:events:extra`, `project:${id}:${epoch}:presence`, `project:${id}:${epoch}:Events`, `project:${id}:${epoch}:`,
    `room:${id}:${epoch}:events`, `project::${epoch}:events`, `project:${id}::events`, `project:${lettered.toUpperCase()}:${epoch}:events`,
    `project:${id}:${lettered.toUpperCase()}:events`, `project:${id.replaceAll("-", "")}:${epoch}:events`, `project:${id}:${epoch.slice(1)}:events`,
    `project:${id}:${epoch}:events `, `project:11111111-1111-6111-8111-111111111111:${epoch}:events`, `project:${id}:${epoch}:${"e".repeat(90)}`,
    `${"p".repeat(91)}`, "", null, undefined, 7, {},
  ];
  for (const input of rejected) assert.equal(parseTopic(input), null, String(input));
});
