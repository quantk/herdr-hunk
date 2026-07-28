export const REVIEW_SCOPES = Object.freeze([
  "uncommitted",
  "branch",
  "last-turn",
]);

export function normalizeScope(scope) {
  return REVIEW_SCOPES.includes(scope) ? scope : "uncommitted";
}

export function noteMatchesScope(note, scope, scopeBase = null) {
  const normalized = normalizeScope(scope);
  if (normalizeScope(note?.scope) !== normalized) return false;
  return normalized !== "last-turn" ||
    (typeof scopeBase === "string" &&
      scopeBase.length > 0 &&
      note.scopeBase === scopeBase);
}

export function scopeLabel(scope) {
  return {
    uncommitted: "working tree",
    branch: "branch",
    "last-turn": "last observed turn",
  }[normalizeScope(scope)];
}
