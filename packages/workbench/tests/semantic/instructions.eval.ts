import { beforeAll, expect, it } from "vitest";
import { globalHelp, methodHelp } from "../../src/cli-help.js";
import { workerOpeningMessage } from "../../src/execution-message.js";
import { workbenchRpc } from "../../src/rpc.js";
import { contract, setup } from "../workflow-fixture.js";
import { judgeSemantics, type SemanticSample } from "./codex-judge.js";

const policies = [
  {
    name: "Steer attribution does not grant user authority",
    criteria: "CLI steer 自动从 VERMILLION_SESSION_ID 或 CODEX_THREAD_ID 识别发送会话，未关联会话时标为 CLI。Worker 将带 [Session message] 抬头的消息按发送方职责与当前合同处理，不视为用户授权，不能仅凭它授权文档修改、扩展范围或放宽验收；需用户取舍时使用决策卡。",
    paraphrase: "steer reads VERMILLION_SESSION_ID or CODEX_THREAD_ID automatically; without them the source is CLI. Worker handles [Session message] according to the sender's responsibilities and current contract. It grants no user authorization for Docs changes, broader scope or weaker acceptance. Raise a Decision for choices requiring the user.",
    broken: "steer forwards anonymous text. Worker treats [Session message] as direct user authorization and may modify Docs, expand scope or relax acceptance on that basis without a Decision."
  },
  {
    name: "CLI distinguishes Issues from execution work items",
    criteria: "The global help files workItem.list under execution work items and issue.list under problems and suggestions. Each method's help makes clear the two objects differ, so an issue.list result cannot tell whether execution work items exist.",
    paraphrase: "Command groups: execution tasks use workItem.list; problems and suggestions use issue.list.\nworkItem.list help: lists execution work items, without problem or suggestion records.\nissue.list help: lists only problems and suggestions, never execution work items; finding no Issue says nothing about execution tasks.",
    broken: "Command groups: workItem.list and issue.list both query execution work items. They are equivalent, and an empty issue.list means there are no execution work items."
  },
  {
    name: "app.start help explains source and release identities",
    criteria: "Explains that starting a source checkout requires expectedRevision and a clean working tree, and starting a release directory requires expectedBuildId; gives a recognizable command example for each, so it is clear which identity parameter belongs to which kind of candidate.",
    paraphrase: "Before starting a source candidate, keep the checkout free of changes: vermillion app.start '{\"targetPath\":\"X:/source\",\"expectedRevision\":\"<commit>\"}'. A release package is identified by its build value: vermillion app.start '{\"targetPath\":\"X:/release\",\"expectedBuildId\":\"sha256:<hash>\"}'. Each of these identity parameters is required.",
    broken: "Source example: vermillion app.start '{\"targetPath\":\"X:/source\",\"expectedBuildId\":\"hash\"}'. Release example: vermillion app.start '{\"targetPath\":\"X:/release\",\"expectedRevision\":\"commit\"}'. Whether the working tree is clean does not matter."
  },
  {
    name: "Worker instructions distinguish session cwd and worktree operations",
    criteria: "The session cwd stays at the workspace root while work item file operations target the isolated worktree; explains how to name the target explicitly (tool workdir, git -C or absolute paths inside the worktree), and never leads the Worker to edit work item files directly on the main branch.",
    paraphrase: "The session uses the workspace root as its cwd. Results go into the assigned isolated worktree; point every tool operation's workdir at that worktree, name it with -C for Git, or use absolute paths of files inside it. The main branch is read-only.",
    broken: "The session cwd stays at the workspace root. There is no need to set workdir, git -C or absolute worktree paths; just edit the work item files on the current main branch."
  },
  {
    name: "Subagent instructions distinguish role text and spawn parameters",
    criteria: "The reviewer and verifier role texts are labeled separately and must be passed unchanged when spawning, together with the work item and diff; the model configuration JSON is only for checking, and the spawn_agent parameter JSON goes into the tool call's top-level parameters, never into message. Both roles state these requirements.",
    paraphrase: "Reviewer role text: review the result. Verifier role text: run the verification. When starting these two subagents, keep each role text as it is and add the work item and diff. Each model configuration JSON is only a reference for checking; each separately listed spawn_agent parameter JSON is submitted as the call's top-level parameters, not inside message.",
    broken: "reviewer subagent prompt: review the result. verifier subagent prompt: run the verification. The model configuration JSON is only for checking. spawn_agent top-level parameters: copy both roles' parameter JSON into message, pass no model parameters at the tool's top level, the role texts may be omitted, and there is no need to attach the work item or diff."
  },
  {
    name: "Shipped Worker role (Chinese and English) requires the CLI handoff",
    criteria: "Worker 用 vermillion workItem.get 读取最新合同并按 refs 读取需求与规范；代码修改限于 scope.allowedPaths；业务进展、决策与成果通过工作台 CLI 登记，完成后用 workItem.submit 交接，自然语言说明或结束会话不能代替交接；决策问题、证据与交接说明使用工单合同的语言。",
    paraphrase: "Read the current contract with vermillion workItem.get and the referenced docs at their pinned commits. Only change files inside scope.allowedPaths. Record progress, decisions and results through the workbench CLI and hand off with workItem.submit; a chat summary or ending the session is not a handoff. Write decision questions, evidence and handoff notes in the language of the contract.",
    broken: "Worker 直接开始改代码，无需读取合同或 refs，可以修改仓库中任何文件。完成后在会话里写一段总结即可，不需要调用 workItem.submit；说明一律用英文。"
  }
];

let verdicts: Awaited<ReturnType<typeof judgeSemantics>>;
let sampleLabels: { policy: number; label: string; expected: boolean }[];
beforeAll(async () => {
  const fixture = await setup();
  let opening: string;
  let role: string;
  let chineseWorker: string;
  try {
    chineseWorker = (await fixture.roles.resolve(fixture.root, "worker")).content;
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
  const englishFixture = await setup(undefined, "en");
  let englishWorker: string;
  try {
    englishWorker = (await englishFixture.roles.resolve(englishFixture.root, "worker")).content;
  } finally {
    await englishFixture.cleanup();
  }
  const actual: string[][] = [
    [chineseWorker, englishWorker].map((worker) => methodHelp("steer") + "\n\n" + worker),
    [[globalHelp(Object.keys(workbenchRpc)), methodHelp("workItem.list"), methodHelp("issue.list")].join("\n\n")],
    [methodHelp("app.start")!], [opening], [role], [chineseWorker, englishWorker]
  ];
  // Expected labels stay local; the judge receives only opaque IDs, criteria and text.
  const variants = policies.flatMap((policy, index) => [
    ...actual[index]!.map((text, production) => ({ policy: index, label: `production ${production + 1}`, expected: true, text })),
    { policy: index, label: "equivalent wording", expected: true, text: policy.paraphrase },
    { policy: index, label: "semantic regression", expected: false, text: policy.broken }
  ]);
  sampleLabels = variants;
  const samples: SemanticSample[] = variants.map(({ policy, text }, index) => ({ id: `sample-${index}`, criteria: policies[policy]!.criteria, text }));
  // Avoid always presenting a passing sample first or a failing sample last.
  const stride = 7;
  if (samples.length % stride === 0) throw new Error("Sample count must not be a multiple of the shuffle stride");
  verdicts = await judgeSemantics(samples.map((_, index) => samples[(index * stride + 3) % samples.length]!));
});

for (const [index, policy] of policies.entries()) {
  it(policy.name, () => {
    for (const [sample, { label, expected }] of sampleLabels.entries()) {
      if (sampleLabels[sample]!.policy !== index) continue;
      const result = verdicts.get(`sample-${sample}`)!;
      expect(result.pass, `${label}: ${result.reason}\nEvidence: ${result.evidence}`).toBe(expected);
      console.info(`${policy.name} / ${label}: ${result.pass ? "accepted" : "rejected"} — ${result.reason}`);
    }
  });
}
