// 测试暂停点(spec m1-99 §0.1)。独立模块以避免 queue ↔ test-hooks 循环依赖。
// 生产构建中 pause 恒为 null(没有任何代码路径能设置它),开销为一次空判断。
export interface PauseSpec { stage: 'presign' | 'put' | 'register'; nth: number }

let pause: PauseSpec | null = null;
const counters: Record<PauseSpec['stage'], number> = { presign: 0, put: 0, register: 0 };

export function setPause(spec: PauseSpec | null): void {
  pause = spec;
  counters.presign = counters.put = counters.register = 0;
}

/** 命中则**永久挂起**(spec §0.1:"命中后挂起,不推进")。
 *  挂起而非抛错,是因为要测的正是"上传中途进程没了":该项停在 uploading/registering,
 *  只有重载后的 recoverAfterRestart 才能把它捞回来。抛错会让队列自己清理干净,
 *  崩溃恢复路径就永远测不到。 */
export function checkPause(stage: PauseSpec['stage']): Promise<void> {
  if (!pause || pause.stage !== stage) return Promise.resolve();
  counters[stage] += 1;
  if (counters[stage] >= pause.nth) {
    pause = null;
    return new Promise<void>(() => { /* 永不 settle */ });
  }
  return Promise.resolve();
}
