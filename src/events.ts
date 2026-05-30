type Listener = (event: string, data: unknown) => void;

export class EventHub {
  private listeners = new Set<Listener>();
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(event: string, data: unknown) {
    for (const l of this.listeners) l(event, data);
  }
}
