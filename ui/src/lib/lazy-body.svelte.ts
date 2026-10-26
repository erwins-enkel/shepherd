/** A preview's full description, loaded whenever the row it reads changes. An answer for a row the
 *  preview has already left is dropped. Create it during component init: it owns an $effect. */
export class LazyBody {
  /** null while loading (or with nothing to load). */
  body = $state<string | null>(null);
  error = $state(false);
  #attempt = $state(0);

  constructor(
    target: () => { repo: string; number: number } | null,
    load: (repo: string, number: number) => Promise<{ body: string }>,
  ) {
    // A primitive key, so a snapshot refresh that rebuilds the row object doesn't reload it.
    const wanted = $derived.by(() => {
      const t = target();
      return t ? JSON.stringify([t.repo, t.number]) : null;
    });
    $effect(() => {
      const key = wanted;
      void this.#attempt;
      this.body = null;
      this.error = false;
      if (key === null) return;
      const [repo, number] = JSON.parse(key) as [string, number];
      let current = true;
      void load(repo, number).then(
        (result) => {
          if (current) this.body = result.body;
        },
        () => {
          if (current) this.error = true;
        },
      );
      return () => {
        current = false;
      };
    });
  }

  retry() {
    this.#attempt++;
  }
}
