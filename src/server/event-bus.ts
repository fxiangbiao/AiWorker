/**
 * 事件总线 — WebSocket 全局实时通道（对齐 DSH 事件投影思想）
 * 职责：广播服务端事件到全部 WS 客户端（会话元数据变更 / 任务事件 / 状态）
 * 说明：SSE 是单次任务（chat/plan/debate）的请求-响应事件流；
 *       本总线是全局下行通道，SSE 与 WS 双写，前端按通道职责消费。
 */

export type BusSubscriber = (data: object) => void;

export class EventBus {
  private subscribers = new Set<BusSubscriber>();

  subscribe(cb: BusSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  broadcast(data: object): void {
    for (const cb of this.subscribers) {
      try {
        cb(data);
      } catch {
        /* 单个订阅者异常不影响其他 */
      }
    }
  }

  get size(): number {
    return this.subscribers.size;
  }
}

export const eventBus = new EventBus();
