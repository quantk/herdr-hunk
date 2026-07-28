import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RESTING = new Set(["idle", "done"]);

export function parseAgentStatus(stdout, paneId) {
  const parsed = JSON.parse(stdout);
  const agents = parsed?.result?.agents;
  if (!Array.isArray(agents)) return "unknown";
  return (
    agents.find((agent) => agent?.pane_id === paneId)?.agent_status ??
    "unknown"
  );
}

export class AgentTurnTracker {
  constructor({ source, herdr = "herdr", agentPaneId, reviewKey }) {
    this.source = source;
    this.herdr = herdr;
    this.agentPaneId = agentPaneId;
    this.baselineRef = `refs/herdr-hunk/turn-base/${reviewKey}`;
    this.targetRef = `refs/herdr-hunk/turn-target/${reviewKey}`;
    this.candidateRef = `refs/herdr-hunk/turn-candidate/${reviewKey}`;
    this.previousStatus = null;
    this.baseline = null;
    this.target = null;
    this.candidate = null;
    this.trackingTurn = false;
    this.lastMarker = null;
    this.lastError = null;
  }

  async initialize() {
    this.baseline = await this.source.readTreeRef(this.baselineRef);
    this.target = await this.source.readTreeRef(this.targetRef);
    this.candidate = await this.source.readTreeRef(this.candidateRef);
    this.source.setTurnBaseline(this.baseline);
    this.source.setTurnTarget(this.target);
  }

  async readStatus() {
    const { stdout } = await execFileAsync(
      this.herdr,
      ["agent", "list"],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return parseAgentStatus(stdout, this.agentPaneId);
  }

  async sample() {
    try {
      const status = await this.readStatus();
      if (this.previousStatus == null) {
        this.previousStatus = status;
        if (RESTING.has(status) && this.candidate) {
          this.candidate = null;
          await this.source.deleteTreeRef(this.candidateRef);
        }
        this.lastError = null;
        this.source.setTurnTrackingError?.(null);
        return false;
      }

      const started =
        RESTING.has(this.previousStatus) &&
        status === "working";
      this.previousStatus = status;
      if (started) {
        this.lastMarker =
          await this.source.workingStateFingerprint?.() ?? null;
        this.candidate = await this.source.snapshotWorktree();
        await this.source.writeTreeRef(this.candidateRef, this.candidate);
        this.lastError = null;
        this.source.setTurnTrackingError?.(null);
        return false;
      }

      if (this.candidate) {
        const marker =
          await this.source.workingStateFingerprint?.() ?? null;
        if (marker != null && marker === this.lastMarker) {
          if (RESTING.has(status)) {
            this.candidate = null;
            await this.source.deleteTreeRef(this.candidateRef);
          }
          this.lastError = null;
          this.source.setTurnTrackingError?.(null);
          return false;
        }
        const current = await this.source.snapshotWorktree();
        this.lastMarker = marker;
        if (current !== this.candidate) {
          this.baseline = this.candidate;
          this.target = current;
          this.candidate = null;
          this.trackingTurn = !RESTING.has(status);
          await this.source.writeTreeRef(this.baselineRef, this.baseline);
          await this.source.writeTreeRef(this.targetRef, this.target);
          await this.source.deleteTreeRef(this.candidateRef);
          this.source.setTurnBaseline(this.baseline);
          this.source.setTurnTarget(this.target);
          this.lastError = null;
          this.source.setTurnTrackingError?.(null);
          return true;
        }
        if (RESTING.has(status)) {
          this.candidate = null;
          await this.source.deleteTreeRef(this.candidateRef);
        }
      }
      if (this.trackingTurn) {
        const marker =
          await this.source.workingStateFingerprint?.() ?? null;
        if (marker != null && marker === this.lastMarker) {
          if (RESTING.has(status)) this.trackingTurn = false;
          this.lastError = null;
          this.source.setTurnTrackingError?.(null);
          return false;
        }
        const current = await this.source.snapshotWorktree();
        this.lastMarker = marker;
        const changed = current !== this.target;
        if (changed) {
          this.target = current;
          await this.source.writeTreeRef(this.targetRef, this.target);
          this.source.setTurnTarget(this.target);
        }
        if (RESTING.has(status)) this.trackingTurn = false;
        this.lastError = null;
        this.source.setTurnTrackingError?.(null);
        return changed;
      }
      this.lastError = null;
      this.source.setTurnTrackingError?.(null);
      return false;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.source.setTurnTrackingError?.(this.lastError);
      return false;
    }
  }
}
