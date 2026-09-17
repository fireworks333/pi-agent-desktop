import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  buildDelegationPrefix,
  hasDelegationPrefix,
  applyDelegationPrefix,
  stripDelegationPrefix,
} = await jiti.import("./dispatch-prefix.ts");

const USER_MESSAGE = "Refactor the parser into three modules";

test("no policy block when delegation is off", () => {
  assert.equal(buildDelegationPrefix({ autoDispatch: false, workerModel: null }), null);
  // The message must pass through untouched.
  assert.equal(
    applyDelegationPrefix(USER_MESSAGE, { autoDispatch: false, workerModel: null }),
    USER_MESSAGE,
  );
});

test("a policy block is produced when delegation is on", () => {
  const prefix = buildDelegationPrefix({ autoDispatch: true, workerModel: null });
  assert.ok(prefix);
  assert.match(prefix, /<delegation-policy>/);
  assert.match(prefix, /<\/delegation-policy>/);
  // The instruction has to name the tool, or the model has nothing to call.
  assert.match(prefix, /`subagent`/);
});

test("names the configured worker model when one is set", () => {
  const prefix = buildDelegationPrefix({
    autoDispatch: true,
    workerModel: { provider: "lilwan", modelId: "deepseek-v4-flash" },
  });
  assert.match(prefix, /lilwan\/deepseek-v4-flash/);
});

test("the policy leads the turn and the user text survives verbatim", () => {
  const result = applyDelegationPrefix(USER_MESSAGE, {
    autoDispatch: true,
    workerModel: null,
  });
  assert.ok(result.startsWith("<delegation-policy>"));
  assert.ok(result.endsWith(USER_MESSAGE));
  assert.ok(result.length > USER_MESSAGE.length);
});

test("already-prefixed messages are not wrapped twice", () => {
  const once = applyDelegationPrefix(USER_MESSAGE, { autoDispatch: true, workerModel: null });
  const twice = applyDelegationPrefix(once, { autoDispatch: true, workerModel: null });
  assert.equal(once, twice);
  assert.equal(hasDelegationPrefix(once), true);
  assert.equal(hasDelegationPrefix(USER_MESSAGE), false);
});

test("the block stays short enough to prepay on every turn", () => {
  const prefix = buildDelegationPrefix({
    autoDispatch: true,
    workerModel: { provider: "PM", modelId: "cheap-model" },
  });
  // Roughly a hundred tokens; anything much larger starts to cost real money
  // per turn, including turns where nothing gets delegated.
  assert.ok(prefix.length < 900, `prefix was ${prefix.length} chars`);
});

test("strips the policy block back to exactly what the user typed", () => {
  const injected = applyDelegationPrefix(USER_MESSAGE, { autoDispatch: true, workerModel: null });
  assert.equal(stripDelegationPrefix(injected), USER_MESSAGE);
});

test("leaves an unprefixed message untouched", () => {
  assert.equal(stripDelegationPrefix(USER_MESSAGE), USER_MESSAGE);
  assert.equal(stripDelegationPrefix(""), "");
});

test("does not mangle a message that merely mentions the tag", () => {
  const text = "why did you print <delegation-policy> in my chat?";
  assert.equal(stripDelegationPrefix(text), text);
});

test("does not mangle a truncated block with no closing tag", () => {
  const text = "<delegation-policy>\nsome partial content";
  assert.equal(stripDelegationPrefix(text), text);
});

test("strips a multi-line message without eating its body", () => {
  const body = "line one\nline two\n\nline four";
  const injected = applyDelegationPrefix(body, { autoDispatch: true, workerModel: null });
  assert.equal(stripDelegationPrefix(injected), body);
});
