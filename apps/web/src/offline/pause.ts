// 测试暂停点(spec m1-99 §0.1)。独立模块以避免 queue ↔ test-hooks 循环依赖。
// 生产构建中 pause 恒为 null(没有任何代码路径能设置它),开销为一次空判断。
export interface PauseSpec { stage: 'presign' | 'put' | 'register'; nth: number }

export class PausedByTest extends Error {
  constructor(readonly stage: string) {
    super(`paused-by-test:${stage}`);
  }
}

let pause: PauseSpec | null = null;
const counters: Record<PauseSpec['stage'], number> = { presign: 0, put: 0, register: 0 };

export function setPause(spec: PauseSpec | null): void {
  pause = spec;
  counters.presign = counters.put = counters.register = 0;
}

/** 命中则抛 PausedByTest —— 队列按"网络类可重试"处理,该项停在 pending,可确定性地 reload */
export function checkPause(stage: PauseSpec['stage']): void {
  if (!pause || pause.stage !== stage) return;
  counters[stage] += 1;
  if (counters[stage] >= pause.nth) {
    pause = null;
    throw new PausedByTest(stage);
  }
}
