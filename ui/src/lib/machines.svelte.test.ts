import { describe, it, expect, vi, beforeEach } from "vitest";
import { machines } from "./machines.svelte";
import { getInstance, listRemoteInstances } from "./api";
import type { RemoteInstance } from "./types";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, listRemoteInstances: vi.fn(), getInstance: vi.fn() };
});
const mockList = vi.mocked(listRemoteInstances);
const mockInstance = vi.mocked(getInstance);

const machine = (instanceId: string, createdAt: number) =>
  ({ instanceId, name: instanceId, createdAt }) as RemoteInstance;

beforeEach(() => {
  vi.clearAllMocks();
  machines.list = [];
  machines.self = null;
});

describe("machines store (#3055)", () => {
  it("reads the list, this Shepherd once a machine is known, and each machine's color", async () => {
    mockList.mockResolvedValue({ instances: [machine("m2", 2), machine("m1", 1)] });
    mockInstance.mockResolvedValue({ instanceId: "self", name: "moes-tavern" } as never);
    await machines.refresh();
    expect(machines.list.map((x) => x.instanceId)).toEqual(["m2", "m1"]);
    expect(machines.self?.name).toBe("moes-tavern");
    expect(machines.colorOf("m1")).toBe("var(--color-data-1)");
    expect(machines.colorOf("m2")).toBe("var(--color-data-2)");
  });

  it("asks for nothing more without machines", async () => {
    mockList.mockResolvedValue({ instances: [] });
    await machines.refresh();
    expect(mockInstance).not.toHaveBeenCalled();
  });

  it("refreshes arriving during a read coalesce into one more read", async () => {
    let release!: () => void;
    mockList.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ instances: [machine("a", 1)] }))),
    );
    mockList.mockResolvedValue({ instances: [] });
    mockInstance.mockResolvedValue({ instanceId: "self", name: "x" } as never);
    const first = machines.refresh();
    void machines.refresh();
    void machines.refresh();
    release();
    await first;
    await vi.waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(machines.list).toEqual([]));
  });

  it("a failed read keeps the last known list", async () => {
    mockList.mockResolvedValueOnce({ instances: [machine("a", 1)] });
    mockInstance.mockResolvedValue({ instanceId: "self", name: "x" } as never);
    await machines.refresh();
    mockList.mockRejectedValueOnce(new Error("offline"));
    await machines.refresh();
    expect(machines.list.map((x) => x.instanceId)).toEqual(["a"]);
  });
});
