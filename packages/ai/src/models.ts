// spec m2-02 §1:模型 ID 的**单一出处**。CI 断言 B2 会扫描全仓,
// 除本文件外任何 src 下出现 `claude-` 字面量都判失败。
//
// 为什么值得一条 CI 断言:模型换代时,散落在调用点的模型名会漏改一两处,
// 而漏改的表现是"某条路径悄悄用着旧模型",既不报错也难察觉。

/** 视觉提取与分类。Opus 5:1M 上下文、高分辨率视觉档(长边 2576 / 4784 视觉 token)。 */
export const MODEL = 'claude-opus-5' as const;

/** 结构化输出 + 服务端 fallback 都要求走 beta 命名空间(m2-02 §2 / 审核 #003 A1) */
export const BETAS = ['server-side-fallback-2026-07-01'] as const;

/** S1 是抄写与分类,不是推理任务 —— 更高档位只增加成本与延迟(m2-02 §2.3) */
export const S1_EFFORT = 'medium' as const;

export const S1_MAX_TOKENS = 16_000;
/** stop_reason='max_tokens' 时的唯一一次重试(m2-02 §5.4) */
export const S1_MAX_TOKENS_RETRY = 32_000;

/** 单请求 image 块上限。超过 20 会触发更严的逐图尺寸限制(每张 ≤2000px),
 *  使 ai 变体的 2576px 失效 —— 必须分批(m2-02 §3.4)。 */
export const MAX_IMAGES_PER_REQUEST = 20;
