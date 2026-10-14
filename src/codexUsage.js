import { BridgeError } from "./errors.js";

const PLANS = new Set(["free", "go", "plus", "pro", "prolite", "team", "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu", "unknown"]);
const LIMIT_STATES = new Set(["rate_limit_reached", "workspace_owner_credits_depleted", "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;

function normalizeWindow(window) {
  if (window == null) return null;
  if (!object(window)) throw new BridgeError("CODEX_PROTOCOL");
  const used = number(window.usedPercent);
  const minutes = number(window.windowDurationMins);
  const reset = number(window.resetsAt);
  return {
    used_percent: used !== null && used >= 0 ? used : null,
    remaining_percent: used !== null && used >= 0 ? Math.max(0, 100 - used) : null,
    window_minutes: minutes !== null && minutes > 0 ? minutes : null,
    reset_at: reset !== null && Number.isSafeInteger(reset) && reset > 0 && reset <= 8640000000000 ? reset : null,
  };
}

export function normalizeSnapshot(payload, now = new Date()) {
  if (!object(payload)) throw new BridgeError("CODEX_PROTOCOL");
  let rateLimit;
  if (payload.rateLimitsByLimitId != null) {
    if (!object(payload.rateLimitsByLimitId) || !Object.hasOwn(payload.rateLimitsByLimitId, "codex")) throw new BridgeError("CODEX_PROTOCOL");
    rateLimit = payload.rateLimitsByLimitId.codex;
  } else {
    rateLimit = payload.rateLimits;
  }
  if (!object(rateLimit) || (rateLimit.limitId != null && rateLimit.limitId !== "codex")) throw new BridgeError("CODEX_PROTOCOL");
  const primary = normalizeWindow(rateLimit.primary);
  const secondary = normalizeWindow(rateLimit.secondary);
  const plan = rateLimit.planType ?? payload.accountPlan;
  const rawBalance = rateLimit.credits?.balance;
  const balance = typeof rawBalance === "string" && /^\d{1,15}(?:\.\d{1,6})?$/.test(rawBalance) ? rawBalance : null;
  const limitState = rateLimit.rateLimitReachedType;
  // Explicit null means no reported limit; missing/unrecognized status stays unknown.
  const status = LIMIT_STATES.has(limitState) ? limitState :
    limitState === null && (primary?.used_percent != null || secondary?.used_percent != null) ? "OK" : "unknown";
  return {
    source: "codex_app_server", captured_at: now.toISOString(),
    plan: PLANS.has(plan) ? plan : null, primary, secondary,
    credits: {
      has_credits: typeof rateLimit.credits?.hasCredits === "boolean" ? rateLimit.credits.hasCredits : null,
      unlimited: typeof rateLimit.credits?.unlimited === "boolean" ? rateLimit.credits.unlimited : null,
      balance,
    },
    rate_limit_reached_type: status,
  };
}

function formatResetTime(epochSeconds, includeDate) {
  if (epochSeconds == null) return null;
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (!includeDate) return time;
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")} - ${time}`;
}

export function flattenForMqtt(snapshot) {
  const resetAfter = window => window?.reset_at == null ? null : Math.max(0, window.reset_at - Math.floor(Date.parse(snapshot.captured_at) / 1000));
  return {
    plan: snapshot.plan, captured_at: snapshot.captured_at, source: snapshot.source,
    primary_used_percent: snapshot.primary?.used_percent ?? null,
    primary_remaining_percent: snapshot.primary?.remaining_percent ?? null,
    primary_window_minutes: snapshot.primary?.window_minutes ?? null,
    primary_reset_at: snapshot.primary?.reset_at ?? null,
    primary_reset_time: formatResetTime(snapshot.primary?.reset_at, false),
    primary_reset_after_seconds: resetAfter(snapshot.primary),
    secondary_used_percent: snapshot.secondary?.used_percent ?? null,
    secondary_remaining_percent: snapshot.secondary?.remaining_percent ?? null,
    secondary_window_minutes: snapshot.secondary?.window_minutes ?? null,
    secondary_reset_at: snapshot.secondary?.reset_at ?? null,
    secondary_reset_time: formatResetTime(snapshot.secondary?.reset_at, true),
    secondary_reset_after_seconds: resetAfter(snapshot.secondary),
    credits_has_credits: snapshot.credits.has_credits,
    credits_unlimited: snapshot.credits.unlimited,
    credits_balance: snapshot.credits.balance,
    rate_limit_reached_type: snapshot.rate_limit_reached_type,
  };
}
