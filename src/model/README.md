# Model-Aware Content Spec

模型能读到的每一段自然语言和协议说明都从实现代码中抽离，集中在本目录。
实现代码只负责组合与执行。

## 文件与变化来源

| 文件 | 唯一变化来源 | 内容 |
| --- | --- | --- |
| `prompt.ts` | b2f 块协议的模型可见表面 | `DEFAULT_PROMPT`（全量内容模式）、`REPLACE_PROMPT`（`mode=edit`）、`GIT_DIFF_PROMPT`（`mode=diff`）、`buildPrompt()` 组合函数 |

规则：一个文件只有一个变化来源。修改模型可见的协议措辞、示例或规则说明时只改本目录；
修改解析、校验、编辑求解、事务与反馈渲染时改
`../parser.ts` / `../validator.ts` / `../edit.ts` / `../transaction.ts` /
`../feedback.ts` / `../service.ts` / `../index.ts`，不要动本目录内容。

`buildPrompt(base, editFormat)` 保证任一时刻只有一种编辑方言进入装配后的提示，
模型不需要在两种 patch 格式之间做选择。未启用的那种由 validator 以
`EDIT_MODE_DISABLED` 拒绝。

## 反馈文本的归属

`[b2f]` 运行时反馈（committed / stale / edit-unresolved 等）由 `../feedback.ts`
从事务报告渲染，属于运行时结果而非静态提示，因此不在本目录。其中回显文件内容
一律使用 `path=` 而非 `file=` 标签，保证模型原样抄回时不会被解析成写入指令。

## 模型感知内容的固定测试

- `../../tests/index.spec.ts`
  - 装配后的提示只包含当前 `editFormat` 对应的方言，不含另一种。
  - `editFormat: none` 时两种编辑方言都不出现，全量内容协议仍在。
  - 非活跃编辑模式被拒绝为 `EDIT_MODE_DISABLED` 且不落盘。
  - 回显块经 `parseFileBlocks` 解析回来为零块零错误（回显不可执行）。
