import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { InboxItem, WorkbenchClient } from "@vermillion/workbench/client";
import { MobileInbox } from "../src/ui/mobile/MobileInbox.js";

const client = { request: vi.fn(), subscribe: vi.fn() } as unknown as WorkbenchClient;
const decision: Extract<InboxItem, { kind: "decision" }> = {
  kind: "decision", workspaceId: "workspace",
  card: { decisionId: "decision", question: "选择方案", context: "上下文", createdAt: "2026-09-26T00:00:00Z",
    options: [{ key: "keep", label: "保留", detail: "保留已有能力" }], recommended: "keep", recommendation: "可以继续使用" }
};
const render = (item: InboxItem) => renderToStaticMarkup(<MobileInbox items={[item]} loading={false}
  route={{ page: "inbox" }} client={client} refresh={async () => undefined} openSession={() => undefined} />);

it("shows persisted pending answers instead of offering a replacement answer", () => {
  const html = render({ ...decision, card: { ...decision.card, answer: { key: "keep", note: "原答复", at: "2026-09-26T01:00:00Z" },
    deliveryPending: true, deliveryFailure: "执行会话未连接" } });
  expect(html).toContain("原答复");
  expect(html).toContain("答复已登记，等待交付");
  expect(html).toContain("执行会话未连接");
  expect(html).toContain("重试送达");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("提交答复");
});

it("keeps consequences and recommendation visible before the user decides", () => {
  const html = render(decision);
  expect(html).toContain("保留已有能力");
  expect(html).toContain("可以继续使用");
  expect(html).toContain("答复说明");
  expect(html).toContain("提交答复");
});
