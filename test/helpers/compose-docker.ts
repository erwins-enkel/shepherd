/** Stateful Docker boundary shared by cleanup and archive tests; never contacts a daemon. */
export function composeDocker() {
  const containers = new Map<string, Record<string, string>>();
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const volumes = new Set(["persistent-data"]);
  let endpoint = "unix:///var/run/docker.sock";
  const add = (project: string, workingDir?: string) => {
    const id = (containers.size + 1).toString(16).padStart(12, "0");
    const labels: Record<string, string> = { "com.docker.compose.project": project };
    if (workingDir !== undefined) labels["com.docker.compose.project.working_dir"] = workingDir;
    containers.set(id, labels);
    return id;
  };
  const run = async (args: string[], timeoutMs: number): Promise<string> => {
    calls.push({ args, timeoutMs });
    const command = args[0] === "--host" ? args.slice(2) : args;
    if (command[0] === "context") return JSON.stringify(endpoint);
    if (command[0] === "compose" && command[1] === "version")
      return "Docker Compose version v2.39.4";
    if (command[0] === "ps") {
      const filter = command[command.indexOf("--filter") + 1]!;
      const project = filter.split("=").slice(2).join("=");
      return [...containers]
        .filter(([, labels]) => !project || labels["com.docker.compose.project"] === project)
        .map(([id]) => id)
        .join("\n");
    }
    if (command[0] === "inspect") {
      return command
        .slice(command.indexOf("--format") + 2)
        .map((id) => JSON.stringify(containers.get(id)))
        .join("\n");
    }
    if (command[0] === "compose" && command.includes("down")) {
      const project = command[command.indexOf("-p") + 1];
      for (const [id, labels] of containers) {
        if (labels["com.docker.compose.project"] === project) containers.delete(id);
      }
      return "";
    }
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  };
  return {
    containers,
    calls,
    volumes,
    add,
    run,
    setEndpoint: (value: string) => {
      endpoint = value;
    },
  };
}
