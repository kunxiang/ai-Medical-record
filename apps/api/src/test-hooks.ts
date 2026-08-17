// A8 崩溃注入(spec m0-99 A8):仅验收脚本使用,生产恒为 no-op。
// 通过环境无关的进程内注册表实现 —— 验收脚本在同进程内启动服务并设置注入点。

let crashAt: string | null = null;

export function armCrashPoint(name: string | null): void {
  crashAt = name;
}

export class InjectedCrash extends Error {
  constructor(readonly point: string) {
    super(`injected crash at ${point}`);
  }
}

export function crashPoint(name: string): void {
  if (crashAt === name) {
    crashAt = null;
    throw new InjectedCrash(name);
  }
}
