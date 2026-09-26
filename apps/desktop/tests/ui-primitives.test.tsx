// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert, PageHeader, Progress, SegmentedControl, Select, StatusPill, Steps, Tabs, Toggle } from "../src/ui/app/components/ui.js";

afterEach(cleanup);

// jsdom lacks PointerEvent; Base UI dispatches one when a list item is chosen with the keyboard.
if (typeof window.PointerEvent === "undefined") {
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {};
}

const workspaces = [
  { value: "a", label: "vermillion", hint: "I:\\gpt-projects\\vermillion" },
  { value: "b", label: "chat", hint: "I:\\gpt-projects\\chat" }
];

const ControlledSelect = ({ onChange }: { onChange: (value: string) => void }) => {
  const [value, setValue] = useState("a");
  return <Select aria-label="切换 workspace" value={value} options={workspaces} onChange={(next) => { setValue(next); onChange(next); }} />;
};

describe("Select", () => {
  it("renders an app-owned trigger, shows option hints and selects with the pointer", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<ControlledSelect onChange={onChange} />);
    expect(container.querySelector("select")).toBeNull();
    const trigger = screen.getByRole("combobox", { name: "切换 workspace" });
    expect(trigger.textContent).toContain("vermillion");
    await user.click(trigger);
    const list = await screen.findByRole("listbox");
    expect(within(list).getByText("I:\\gpt-projects\\chat")).toBeTruthy();
    await user.click(within(list).getByRole("option", { name: /chat/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("b");
    expect(trigger.textContent).toContain("chat");
  });

  it("supports the keyboard and closes on Escape without changing the value", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSelect onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "切换 workspace" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("selects an option whose value is empty and shows the placeholder when nothing matches", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Select aria-label="筛选" value="a" onChange={onChange} options={[{ value: "", label: "全部" }, ...workspaces]} />);
    await user.click(screen.getByRole("combobox", { name: "筛选" }));
    await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: "全部" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("");
    rerender(<Select aria-label="筛选" value="missing" placeholder="选择 workspace" onChange={onChange} options={workspaces} />);
    expect(screen.getByRole("combobox", { name: "筛选" }).textContent).toContain("选择 workspace");
  });
});

describe("SegmentedControl", () => {
  it("switches views by click and arrow keys and shows counts", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const Probe = () => {
      const [value, setValue] = useState("open");
      return <SegmentedControl label="视图" value={value} onChange={(next) => { setValue(next); onChange(next); }}
        items={[{ value: "open", label: "进行中", count: 2 }, { value: "done", label: "已结束", count: 153 }, { value: "all", label: "全部" }]} />;
    };
    render(<Probe />);
    const open = screen.getByRole("radio", { name: /进行中/ });
    expect(open.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /已结束/ }).textContent).toContain("153");
    await user.click(screen.getByRole("radio", { name: "全部" }));
    expect(onChange).toHaveBeenLastCalledWith("all");
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("open");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /进行中/ }));
  });
});

describe("status primitives", () => {
  it("StatusPill carries its tone and an icon, and Progress renders one segment per item", () => {
    const { container } = render(<>
      <StatusPill tone="attention">已暂停</StatusPill>
      <StatusPill tone="running">执行</StatusPill>
      <Progress segments={["done", "running", "pending"]} label="1 / 3 已合入" />
    </>);
    const pills = container.querySelectorAll(".vm-pill");
    expect([...pills].map((pill) => pill.getAttribute("data-tone"))).toEqual(["attention", "running"]);
    expect(pills[0]!.querySelector("svg")).not.toBeNull();
    expect(container.querySelectorAll(".vm-progress__bar > i")).toHaveLength(3);
    expect(screen.getByText("1 / 3 已合入")).toBeTruthy();
  });

  it("Steps marks the current stage and shows times and the wait note", () => {
    render(<Steps label="工单进度" steps={[
      { label: "排队", time: "06:20", state: "done" },
      { label: "执行", time: "06:27", state: "current", tone: "attention", note: "等待用户决定" },
      { label: "待合入", state: "pending" }
    ]} />);
    const current = screen.getByText("执行").closest("li")!;
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(within(current).getByText("等待用户决定")).toBeTruthy();
    expect(within(screen.getByText("排队").closest("li")!).getByText("06:20")).toBeTruthy();
  });

  it("Alert gives reason, next step and actions; PageHeader holds summary and actions", async () => {
    const onResume = vi.fn();
    const user = userEvent.setup();
    render(<>
      <PageHeader title="工作" summary={<StatusPill tone="attention">1 需要处理</StatusPill>} actions={<button type="button">新建工单</button>} />
      <Alert title="准备会话已被 Codex 归档" next="取消归档后点恢复即可继续。" actions={<button type="button" onClick={onResume}>恢复</button>} />
    </>);
    expect(screen.getByRole("heading", { name: "工作" })).toBeTruthy();
    expect(screen.getByText("1 需要处理")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("取消归档后点恢复即可继续。")).toBeTruthy();
    await user.click(within(alert).getByRole("button", { name: "恢复" }));
    expect(onResume).toHaveBeenCalledOnce();
  });
});

describe("Tabs and Toggle", () => {
  it("shows attention counts only when non-zero and places trailing content in the bar", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Tabs selected="sessions" onSelect={onSelect} items={[{ id: "sessions", label: "会话" }, { id: "workItems", label: "工作", count: 2 }, { id: "issues", label: "Issues", count: 0 }]}>
      <span>vermillion</span>
    </Tabs>);
    expect(screen.getByLabelText("2 项需要处理")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Issues" }).textContent).toBe("Issues");
    expect(within(screen.getByRole("navigation")).getByText("vermillion")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /工作/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("workItems");
  });

  it("Toggle flips its checked state", async () => {
    const Probe = () => { const [on, setOn] = useState(false); return <Toggle label="自动推进" checked={on} onChange={setOn} />; };
    const user = userEvent.setup();
    render(<Probe />);
    const toggle = screen.getByRole("switch", { name: "自动推进" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
