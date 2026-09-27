# 角色规范

默认角色的产品行为见[角色与执行](PRD.md)。

## 双语默认角色

- `packages/workbench/roles/zh/` 是默认角色的唯一手写来源。开发时先改 `~/.vermillion/roles/`，再运行 `pnpm roles:sync` 同步进仓库。
- `packages/workbench/roles/en/` 由 `pnpm roles:sync` 生成，不手改。`roles/en/manifest.json` 记录每个英文文件对应的中文内容 hash。
- `pnpm roles:sync` 依次完成：把 `~/.vermillion/roles/` 中默认角色的正文同步到 `roles/zh/`；按 manifest 找出内容变化的中文文件；把这些文件连同上一版英文和[术语表](../../Foundation/UIUX/Standards.md#界面语言)一次交给 `codex exec` 翻译；写入 `roles/en/` 并更新 manifest。中文没有变化时不调用模型。
- 同步只取全局文件的正文，`roles/zh/` 的 frontmatter 保持仓库原样；全局 frontmatter 里的个人模型配置不进入仓库。英文文件的 frontmatter 与对应中文文件一致，只翻译正文；中文未改动的段落沿用上一版英文，使英文 diff 只反映实际修改。CLI 方法名、参数名、路径和代码块不翻译。
- 调用前核对当前 Codex CLI 支持所用参数。翻译失败、输出不完整或 frontmatter 不一致时不写入任何英文文件和 manifest，命令以非零退出码返回原因。
- `pnpm test` 离线校验 manifest 中的 hash 与 `roles/zh/` 一致，不调用模型；不一致时失败并提示运行 `pnpm roles:sync`。`pnpm package` 执行同样的校验，不打包英文过期的角色。
- 修改角色后运行 `pnpm --filter @vermillion/workbench test:semantic`，评测同时覆盖中文和英文角色。
