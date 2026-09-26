import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatTreeSnapshotRpc } from "@vermillion/shared";
import { mobileSendSessionId } from "../src/ui/chat-shell/MobileSessionPane.js";
import { TurnProcessPanel } from "../src/ui/chat-shell/TurnProcessPanel.js";
import { buildParticipantDirectory } from "../src/ui/chat-shell/participant-directory.js";
import type { TurnTranscriptRow } from "../src/ui/chat-shell/transcript-view-model.js";

vi.mock("xterm", () => ({ Terminal: class {} }));

describe("mobile conversation", () => {
  it("sends to the current branch even when its displayed last turn belongs to an ancestor", () => {
    const path = {
      sessionId: "root", currentSessionId: "new-branch", visibleNodeIds: ["parent-turn"],
      nodes: [{ nodeId: "parent-turn", sessionId: "root" }]
    } as ChatTreeSnapshotRpc;
    expect(mobileSendSessionId(path)).toBe("new-branch");
  });

  it("collapses running tool output without concealing pending approval controls", () => {
    const row = {
      toolCalls: [{ toolCallId: "tool", sessionId: "s", turnId: "t", toolName: "shell", status: "running", inputSummary: "pwd" }],
      terminalStreams: [], interactions: [],
      approvals: [{ requestId: "approval", sessionId: "s", turnId: "t", status: "pending", kind: "command", title: "Allow command", requestedAt: "2026-09-26T00:00:00Z" }]
    } as unknown as TurnTranscriptRow;
    const render = (collapseActivity: boolean) => renderToStaticMarkup(<TurnProcessPanel
      row={row} participantDirectory={buildParticipantDirectory([])} collapseActivity={collapseActivity}
      onRespondApproval={async () => undefined} />);
    const mobile = render(true);
    expect(mobile).toContain('<details class="awb-mobile-activity">');
    expect(mobile).not.toContain('<details class="awb-mobile-activity" open');
    expect(mobile.indexOf("Allow command")).toBeGreaterThan(mobile.indexOf("</details>"));
    expect(mobile).toContain("Approve");
    expect(render(false)).not.toContain("awb-mobile-activity");
  });
});
