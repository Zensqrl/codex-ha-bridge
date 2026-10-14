import test from "node:test";
import assert from "node:assert/strict";
import { flattenForMqtt, normalizeSnapshot } from "../src/codexUsage.js";
const now = new Date("2026-10-14T12:00:00Z");
const bucket = {
  limitId: "codex", planType: "plus", rateLimitReachedType: null,
  primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: now.getTime() / 1000 + 3600 },
  secondary: { usedPercent: 101, windowDurationMins: 10080, resetsAt: null },
  credits: { hasCredits: true, unlimited: false, balance: "42.5" },
};

test("maps generated app-server schema, prefers Codex bucket, excludes secrets and PII", () => {
  const state = flattenForMqtt(normalizeSnapshot({
    accountPlan: "pro", email: "PRIVATE_EMAIL", tokens: { access_token: "DUMMY_SECRET" },
    rateLimits: { ...bucket, primary: { usedPercent: 99 } },
    rateLimitsByLimitId: { codex: bucket, other: { primary: { usedPercent: 77 } } },
  }, now));
  assert.equal(state.primary_used_percent, 25);
  assert.equal(state.primary_remaining_percent, 75);
  assert.equal(state.secondary_remaining_percent, 0);
  assert.equal(state.primary_reset_after_seconds, 3600);
  assert.equal(state.credits_balance, "42.5");
  assert.equal(state.rate_limit_reached_type, "OK");
  assert.equal(state.plan, "plus");
  assert.doesNotMatch(JSON.stringify(state), /DUMMY_SECRET|PRIVATE_EMAIL|access_token|other/);
});

test("missing and malformed values remain unknown instead of zero or OK", () => {
  const state = flattenForMqtt(normalizeSnapshot({ rateLimits: {
    primary: { usedPercent: "25", windowDurationMins: -1, resetsAt: 1e30 },
    credits: { balance: "DUMMY_SECRET", hasCredits: "true" },
    planType: "DUMMY_SECRET", rateLimitReachedType: "DUMMY_SECRET",
  } }, now));
  assert.equal(state.primary_used_percent, null);
  assert.equal(state.primary_remaining_percent, null);
  assert.equal(state.primary_reset_time, null);
  assert.equal(state.credits_has_credits, null);
  assert.equal(state.credits_balance, null);
  assert.equal(state.plan, null);
  assert.equal(state.rate_limit_reached_type, "unknown");
  assert.doesNotMatch(JSON.stringify(state), /DUMMY_SECRET/);
  assert.equal(flattenForMqtt(normalizeSnapshot({ rateLimits: { rateLimitReachedType: null } }, now)).rate_limit_reached_type, "unknown");
});

test("missing Codex bucket and invalid structures fail closed", () => {
  for (const payload of [{}, { rateLimits: [] }, { rateLimits: { primary: "invalid" } },
    { rateLimits: bucket, rateLimitsByLimitId: { unrelated: bucket } },
    { rateLimits: { limitId: "unrelated" } }]) {
    assert.throws(() => normalizeSnapshot(payload), { code: "CODEX_PROTOCOL" });
  }
});
