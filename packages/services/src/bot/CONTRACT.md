# bot 模块契约

Personal Bot 的 M1 基础：身份/档案、对话指针、个人记忆、能力面声明。完整设计见
`docs/specs/personal-bot.md`。

## 类型无法表达的不变量

- **身份与对话状态分离**：`identity.json` 与 `conversation.json` 是两个文档。清空或更换对话
  指针不得改动身份/档案/记忆；编辑档案也不得触碰记忆或对话指针。
- **会话内容不属于本模块**：消息与轮次由 CLI `AgentRuntime` + session store 拥有。本模块只
  保存“Bot 的对话是哪个 session”的指针（`sessionId`），从不写入消息。
- **个人记忆 ≠ Project Memory**：`packages/services/src/memory` 是 coding workspace 的
  Markdown 记忆，两者不共用存储、不互相写入。
- **有界检索**：`buildMemoryContext` 永远受条数（默认 8）与字节（4096）上限约束，按记录边界
  截断，并始终报告 `omittedCount`。任何调用方都不得绕过该接口直接注入全量记忆。
- **能力面是声明不是注册表**：`listCapabilitySurface` 只投影“宿主当前真的能执行的能力域”；
  没有实现的域必须呈现为 `not_configured` / `planned`，不得标记 `available`。
- **损坏不静默**：`BotStoreCorruptError` 表示文档存在但不可用。实现方必须保留原文件并向上
  报错，不得删除或覆盖用户数据；“文件不存在”与“文档损坏”是两种不同语义。
- **读取不改盘**：读取路径只做内存归一化（含 workspace 归属校正），落地只发生在显式命令中。
