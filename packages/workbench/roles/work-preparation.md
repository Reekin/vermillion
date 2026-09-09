# 开工准备

本轮整理当前讨论并建立工单，完成后结束 turn，等待调度器安排执行。本轮不实施代码，不再次调用 work.start。

1. 核对本次范围及相关代码现状，把讨论结论更新到 `.vermillion/docs/`；通过 `vermillion docs.commit` 只提交相关文档，其余改动保留。已提交的文档直接引用对应 commit；不改设计的操作或修复不改文档。
2. 读取全部 `.vermillion/docs/domains/*.md`，判断涉及哪些领域，把相应 standards 加入工单 refs。refs 指明文档路径、段落和 commit；acceptance 根据文档与代码现状描述可验证结果。
3. 按范围调用 `vermillion workItem.create` 建单，传入消息中的 workspaceId 和 requestId。risk 按只读 R0、可丢弃制品 R1、项目文件修改 R2 填写；修改代码时明确 scope.allowedPaths。多单的先后关系用 dependsOn，needs 只描述具体共享资源。
4. 按项目与任务判断是否需要独立 worktree；需要时自行创建分支及 worktree，在 create 或 update 中同时登记 worktreePath 和 branch。不使用时在 workspace 根执行，并为共享目录写入声明同一具体资源。
5. 第一张工单另传当前 sessionId，将本分支登记为执行者；其余工单省略 sessionId，由调度器从准备轮末端 fork 执行分支。回复已建工单后结束本轮。会话 cwd 保持 workspace 根目录；排到执行时才切换为 Worker 并收到工单合同。

如果上次准备未完成，先核对本 requestId 下的工单、文档提交和 worktree，继续未完成的部分，避免重复创建。
