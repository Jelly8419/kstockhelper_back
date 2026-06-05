/** KST 타임스탬프가 붙은 단순 로거. */
function ts(): string {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

export const logger = {
  info(msg: string, ...args: unknown[]): void {
    console.log(`[${ts()}] [INFO] ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    console.warn(`[${ts()}] [WARN] ${msg}`, ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    console.error(`[${ts()}] [ERROR] ${msg}`, ...args);
  },
};
