import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publishNotification(userId, event) {
  emitter.emit(userId, event);
}

export function subscribeNotifications(userId, onEvent) {
  emitter.on(userId, onEvent);
  return () => emitter.off(userId, onEvent);
}
