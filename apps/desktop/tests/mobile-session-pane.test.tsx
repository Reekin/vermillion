import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import { mobileSendSessionId, mobileVisiblePath } from "../src/ui/chat-shell/MobileSessionPane.js";
import { TurnProcessPanel } from "../src/ui/chat-shell/TurnProcessPanel.js";
import { buildParticipantDirectory } from "../src/ui/chat-shell/participant-directory.js";
import type { TurnTranscriptRow } from "../src/ui/chat-shell/transcript-view-model.js";

vi.mock("xterm", () => ({ Terminal: class {} }));

describe("mobile conversation", () => {
  it("reads and appends at the selected branch tip while preserving a historical desktop cursor", () => {
    const path = {
      sessionId: "root", currentSessionId: "branch", currentNodeId: "ancestor", visibleNodeIds: ["ancestor"], visibleTurnIds: ["ancestor"],
      nodes: [
        { nodeId: "ancestor", turnId: "ancestor", sessionId: "root", order: 0 },
        { nodeId: "branch-tip", turnId: "branch-tip", parentNodeId: "ancestor", sessionId: "branch", order: 1 },
        { nodeId: "other-tip", turnId: "other-tip", parentNodeId: "ancestor", sessionId: "other", order: 2 }
      ]
    } as ChatTreeSnapshotRpc;
    const mobile = mobileVisiblePath(path);
    expect(mobile.visibleTurnIds).toEqual(["ancestor", "branch-tip"]);
    expect(mobileSendSessionId(mobile)).toBe("branch");
    expect(path.currentNodeId).toBe("ancestor");
    expect(path.visibleTurnIds).toEqual(["ancestor"]);
  });
  it("sends to the current branch even when its displayed last turn belongs to an ancestor", () => {
    const path = {
      sessionId: "root", currentSessionId: "new-branch", visibleNodeIds: ["parent-turn"],
      nodes: [{ nodeId: "parent-turn", sessionId: "root" }]
    } as ChatTreeSnapshotRpc;
    expect(mobileSendSessionId(path)).toBe("new-branch");
  });

  it("shows each running step's own action, one row per step, alongside pending approvals", () => {
    const row = {
      toolCalls: [
        { toolCallId: "tool-1", sessionId: "s", turnId: "t", toolName: "shell", status: "running", inputSummary: "pnpm test", startedAt: "2026-09-26T00:00:01Z" },
        { toolCallId: "tool-2", sessionId: "s", turnId: "t", toolName: "shell", status: "completed", inputSummary: "git status", startedAt: "2026-09-26T00:00:00Z" }
      ],
      terminalStreams: [], interactions: [],
      approvals: [{ requestId: "approval", sessionId: "s", turnId: "t", status: "pending", kind: "command", title: "Allow command", requestedAt: "2026-09-26T00:00:00Z" }]
    } as unknown as TurnTranscriptRow;
    const html = renderToStaticMarkup(<TurnProcessPanel row={row} participantDirectory={buildParticipantDirectory([])} onRespondApproval={async () => undefined} />);
    expect(html.match(/class="awb-process-step__row"/g)).toHaveLength(2);
    expect(html).toContain("pnpm test");
    expect(html).toContain("git status");
    expect(html).toContain("Allow command");
    expect(html).toContain("批准");
  });
});
