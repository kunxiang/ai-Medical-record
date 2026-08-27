import Anthropic from '@anthropic-ai/sdk';
import { deepSeekTransport } from './deepseek-transport.js';
import { AI_PROVIDER } from './models.js';

// spec m2-99 §0:模型调用的注入点。
//
// A/B 组验收断言的是**工程正确性**,不是模型输出 —— 而真实调用既慢又贵,
// 且同一输入两次运行结果可能不同。所以调用必须可替换为录制回放。
// 默认实现是真实 SDK;测试用 setTransport 换掉。

// 用 SDK 的具体非流式类型:create 的重载签名包含 Stream<...>,
// 从 Parameters/ReturnType 推出来的是联合类型,narrow 不掉。
export type BetaMessageCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

export type Transport = (params: BetaMessageCreateParams) => Promise<BetaMessage>;

let client: Anthropic | null = null;
function realClient(): Anthropic {
  // 零参构造:凭证由 SDK 从环境解析(ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant 配置档)。
  // 禁止在代码里硬编码 key(m2-02 §1)。
  client ??= new Anthropic({ timeout: 600_000 });   // TypeScript SDK 的单位是**毫秒**
  return client;
}

const realTransport: Transport = async (params) =>
  AI_PROVIDER === 'deepseek' ? deepSeekTransport(params) : realClient().beta.messages.create(params);
const realStreamTransport: Transport = async (params) =>
  AI_PROVIDER === 'deepseek'
    ? deepSeekTransport(params)
    : realClient().beta.messages.stream(params).finalMessage();

let current: Transport = realTransport;
let currentStream: Transport = realStreamTransport;

export function setTransport(t: Transport | null): void {
  current = t ?? realTransport;
  // 录制/回放注入必须同时覆盖普通与提额流式路径，否则 max_tokens 测试会意外访问真实网络。
  currentStream = t ?? realStreamTransport;
}

export function getTransport(): Transport {
  return current;
}

export function getStreamTransport(): Transport {
  return currentStream;
}

/** 仅供录制/回放和测试分别观察提额流式路径。 */
export function setStreamTransport(t: Transport | null): void {
  currentStream = t ?? realStreamTransport;
}
