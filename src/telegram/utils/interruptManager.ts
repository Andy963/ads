/**
 * 中断管理器 - 管理正在执行的任务，支持用户中断
 */
export class InterruptManager {
  private activeRequests = new Map<number, AbortController>();
  
  /**
   * 注册新请求
   */
  registerRequest(userId: number): AbortController {
    // 清理旧的请求
    const old = this.activeRequests.get(userId);
    if (old) {
      old.abort();
    }
    
    const controller = new AbortController();
    this.activeRequests.set(userId, controller);
    return controller;
  }
  
  /**
   * 用户中断请求
   */
  interrupt(userId: number): boolean {
    const controller = this.activeRequests.get(userId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(userId);
      return true;
    }
    return false;
  }
  
  /**
   * 完成请求
   */
  complete(userId: number): void {
    this.activeRequests.delete(userId);
  }
  
  /**
   * 检查是否有活跃请求
   */
  hasActiveRequest(userId: number): boolean {
    return this.activeRequests.has(userId);
  }
  
  /**
   * 获取 AbortSignal
   */
  getSignal(userId: number): AbortSignal | undefined {
    return this.activeRequests.get(userId)?.signal;
  }
}
