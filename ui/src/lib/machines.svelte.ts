import { getInstance, listRemoteInstances } from "./api";
import { machineColorVar, machineDisplayNames } from "./remote-sessions";
import type { InstanceIdentity, RemoteInstance } from "./types";

/**
 * The connected machines (#2759) as the herd needs them (#3055): the list behind its machine bar
 * — a machine with no sessions still has a chip — this Shepherd's own name, and each machine's
 * color. The page loads it once; the store re-reads it on every `remote:sessions` frame, which the
 * server sends when a machine connects, drops, is removed, and on every probe round.
 */
class Machines {
  list = $state<RemoteInstance[]>([]);
  /** This Shepherd; read once a machine is known, since only the machine bar names it. */
  self = $state<InstanceIdentity | null>(null);
  readonly names = $derived(machineDisplayNames(this.list));
  private inflight: Promise<void> | null = null;
  private again = false;

  /** Re-read the list. While a read is out, at most one more follows it. */
  refresh(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = this.read().finally(() => {
      this.inflight = null;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.inflight;
  }

  /** The machine's color as a CSS value, or null while it is not in the list. */
  colorOf(instanceId: string): string | null {
    return machineColorVar(instanceId, this.list);
  }

  private async read(): Promise<void> {
    try {
      const { instances } = await listRemoteInstances();
      this.list = instances;
      if (instances.length > 0 && !this.self) this.self = await getInstance();
    } catch {
      // Keep the last known list; the next `remote:sessions` frame reads it again.
    }
  }
}

export const machines = new Machines();
