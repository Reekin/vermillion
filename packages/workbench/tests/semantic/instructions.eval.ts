import { beforeAll, expect, it } from "vitest";
import { globalHelp, methodHelp } from "../../src/cli-help.js";
import { workerOpeningMessage } from "../../src/execution-message.js";
import { workbenchRpc } from "../../src/rpc.js";
import { contract, setup } from "../workflow-fixture.js";
import { judgeSemantics, type SemanticSample } from "./codex-judge.js";

const policies = [
  {
    name: "CLI distinguishes Issues from execution work items",
    criteria: "总帮助把 workItem.list 归于执行工单，把 issue.list 归于问题与建议。各自的方法帮助明确这两种对象不同，不能用 issue.list 查询结果判断有没有执行工单。",
    paraphrase: "命令分类：执行任务用 workItem.list，问题和建议用 issue.list。\nworkItem.list 帮助：列出执行工单，不含问题建议记录。\nissue.list 帮助：只列问题建议，不包含执行工单；查不到 Issue 不能说明没有执行任务。",
    broken: "命令分类：workItem.list 和 issue.list 都是执行工单查询。两者等价，issue.list 为空就代表没有执行工单。"
  },
  {
    name: "app.start help explains source and release identities",
    criteria: "说明源码 checkout 启动须指定 expectedRevision 且工作树干净，发布目录启动须指定 expectedBuildId；分别给出可辨认的命令示例，能分清两种身份参数用于哪一种候选。",
    paraphrase: "启动源码候选前先保持 checkout 无改动：vermillion app.start '{\"targetPath\":\"X:/source\",\"expectedRevision\":\"<commit>\"}'。发布包的身份由构建值核对：vermillion app.start '{\"targetPath\":\"X:/release\",\"expectedBuildId\":\"sha256:<hash>\"}'。上述对应身份参数均必填。",
    broken: "源码示例：vermillion app.start '{\"targetPath\":\"X:/source\",\"expectedBuildId\":\"hash\"}'。发布示例：vermillion app.start '{\"targetPath\":\"X:/release\",\"expectedRevision\":\"commit\"}'。工作树是否干净无关紧要。"
  },
  {
    name: "Worker instructions distinguish session cwd and worktree operations",
    criteria: "会话 cwd 留在 workspace 根目录，工单文件操作指向独立 worktree；说明如何显式指定操作目标（工具 workdir、git -C 或 worktree 内绝对路径），不能引导 Worker 在主分支直接修改工单文件。",
    paraphrase: "会话以 workspace 根作为 cwd。开发成果写入分配的独立 worktree；每次工具操作用 workdir 指向该 worktree，Git 用 -C 指定它，也可使用其中文件的绝对路径。主分支只读。",
    broken: "会话 cwd 保持 workspace 根目录。workdir、git -C、worktree 内的绝对路径都无需指定，直接在当前主分支修改工单文件即可。"
  },
  {
    name: "Subagent instructions distinguish role text and spawn parameters",
    criteria: "reviewer 与 verifier 的角色正文分别标识，要求 spawn 时原样传入并附工单和 diff；model configuration JSON 仅用于核对，spawn_agent 参数 JSON 要填在工具调用顶层，不能塞进 message。两种角色都要说明这些要求。",
    paraphrase: "reviewer 角色正文：审阅成果。verifier 角色正文：执行验收。启动这两位子代理时，各自角色正文保持原样，并补上工单及 diff。各自的 model configuration JSON 只作核验参考；各自另列的 spawn_agent 参数 JSON 应作为调用的顶层参数提交，不放在 message 中。",
    broken: "reviewer subagent prompt：审阅成果。verifier subagent prompt：执行验收。model configuration JSON 仅用于核对。spawn_agent top-level parameters：把两位角色的参数 JSON 都复制进 message，工具顶层不要传模型参数，角色正文可省略，也不用附工单或 diff。"
  }
];

let verdicts: Awaited<ReturnType<typeof judgeSemantics>>;
beforeAll(async () => {
  const fixture = await setup();
  let opening: string;
  let role: string;
  try {
    await fixture.roles.writeOverride(fixture.root, "worker", "# Worker\n执行工单。");
    await fixture.roles.writeOverride(fixture.root, "reviewer", "---\nmodel: reviewer-model\nreasoningOptionId: high\n---\n审阅成果。");
    await fixture.roles.writeOverride(fixture.root, "verifier", "---\nmodel: verifier-model\nreasoningOptionId: max\n---\n执行验收。");
    const item = await fixture.service.createWorkItem(fixture.workspaceId, { ...contract, sessionId: "worker" });
    item.run.worktreePath = fixture.root + "/worker-tree";
    item.run.branch = "worker-test";
    opening = workerOpeningMessage(fixture.workspaceId, item, fixture.root);
    role = (await fixture.service.resolveWorkerRole(fixture.workspaceId)).content;
  } finally {
    await fixture.cleanup();
  }
  const actual = [
    [globalHelp(Object.keys(workbenchRpc)), methodHelp("workItem.list"), methodHelp("issue.list")].join("\n\n"),
    methodHelp("app.start")!, opening, role
  ];
  // Expected labels stay local; the judge receives only opaque IDs, criteria and text.
  const samples: SemanticSample[] = policies.flatMap((policy, index) =>
    [actual[index]!, policy.paraphrase, policy.broken].map((text, variant) => ({
      id: `sample-${index * 3 + variant}`, criteria: policy.criteria, text
    }))
  );
  // Avoid always presenting a passing sample first or a failing sample last.
  const order = [8, 0, 10, 4, 2, 9, 6, 5, 1, 11, 3, 7];
  verdicts = await judgeSemantics(order.map((index) => samples[index]!));
});

for (const [index, policy] of policies.entries()) {
  it(policy.name, () => {
    for (const [variant, label] of ["production", "equivalent wording", "semantic regression"].entries()) {
      const result = verdicts.get(`sample-${index * 3 + variant}`)!;
      expect(result.pass, `${label}: ${result.reason}\nEvidence: ${result.evidence}`).toBe(variant !== 2);
      console.info(`${policy.name} / ${label}: ${result.pass ? "accepted" : "rejected"} — ${result.reason}`);
    }
  });
}
