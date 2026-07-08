import { Injectable } from "@nestjs/common";
import { EventEmitter } from "node:events";

export interface NotificationEvent {
  type: "NEW_REPLY" | "MATCH_FOUND";
  loadRef: string | null;
  outreachThreadId?: string;
}

/**
 * In-process pub/sub — fine for a single API instance. Once running >1
 * instance, swap this for Redis pub/sub (per-user channel) as noted in the
 * plan's real-time notification design; the publish/subscribe call sites
 * below wouldn't need to change, only this class's internals.
 */
@Injectable()
export class NotificationsService {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0); // unbounded — one listener per open SSE connection
  }

  publish(userId: string, event: NotificationEvent): void {
    this.emitter.emit(userId, event);
  }

  subscribe(userId: string, onEvent: (event: NotificationEvent) => void): () => void {
    this.emitter.on(userId, onEvent);
    return () => this.emitter.off(userId, onEvent);
  }
}
