import { EventEmitter } from 'node:events';

export interface LiveEvent {
  type: string;
  runId?: string;
  [key: string]: unknown;
}

export class Bus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(300);
  }

  publish(event: LiveEvent) {
    this.emitter.emit('all', event);
    if (event.runId) this.emitter.emit(`run:${event.runId}`, event);
  }

  subscribeRun(runId: string, listener: (event: LiveEvent) => void) {
    const channel = `run:${runId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  subscribeAll(listener: (event: LiveEvent) => void) {
    this.emitter.on('all', listener);
    return () => this.emitter.off('all', listener);
  }
}
