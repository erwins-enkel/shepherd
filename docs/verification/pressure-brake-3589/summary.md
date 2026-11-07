# Pressure-brake calibration summary

## Hosts

| Rep    | CPUs | RAM       | Swap     | Kernel           | Run    | OOM kills |
| ------ | ---- | --------- | -------- | ---------------- | ------ | --------- |
| l8-r1  | 4    | 15.61 GiB | 3.00 GiB | 7.0.0-1019-azure | 1871 s | 0         |
| l8-r2  | 4    | 15.61 GiB | 3.00 GiB | 7.0.0-1019-azure | 1963 s | 0         |
| l12-r1 | 4    | 15.61 GiB | 3.00 GiB | 7.0.0-1019-azure | 2669 s | 0         |
| l12-r2 | 4    | 15.61 GiB | 3.00 GiB | 7.0.0-1019-azure | 1693 s | 0         |
| l12-r3 | 4    | 15.61 GiB | 3.00 GiB | 7.0.0-1019-azure | 2501 s | 0         |

## Solo baseline

| Rep    | Workload     | Duration | Peak tree RSS | Exit |
| ------ | ------------ | -------- | ------------- | ---- |
| l8-r1  | cargo        | 50 s     | 1.52 GiB      | 0    |
| l8-r1  | typecheck    | 12 s     | 1.57 GiB      | 0    |
| l8-r1  | svelte-check | 29 s     | 2.70 GiB      | 0    |
| l8-r1  | vite-build   | 29 s     | 3.52 GiB      | 0    |
| l8-r1  | browser      | 13 s     | 3.26 GiB      | 0    |
| l8-r2  | cargo        | 60 s     | 1.54 GiB      | 0    |
| l8-r2  | typecheck    | 15 s     | 1.53 GiB      | 0    |
| l8-r2  | svelte-check | 36 s     | 2.75 GiB      | 0    |
| l8-r2  | vite-build   | 35 s     | 3.49 GiB      | 0    |
| l8-r2  | browser      | 15 s     | 3.24 GiB      | 0    |
| l12-r1 | cargo        | 78 s     | 1.55 GiB      | 0    |
| l12-r1 | typecheck    | 21 s     | 1.54 GiB      | 0    |
| l12-r1 | svelte-check | 48 s     | 2.75 GiB      | 0    |
| l12-r1 | vite-build   | 46 s     | 3.47 GiB      | 0    |
| l12-r1 | browser      | 19 s     | 3.23 GiB      | 0    |
| l12-r2 | cargo        | 62 s     | 1.56 GiB      | 0    |
| l12-r2 | typecheck    | 13 s     | 1.60 GiB      | 0    |
| l12-r2 | svelte-check | 30 s     | 2.72 GiB      | 0    |
| l12-r2 | vite-build   | 29 s     | 3.32 GiB      | 0    |
| l12-r2 | browser      | 13 s     | 3.26 GiB      | 0    |
| l12-r3 | cargo        | 72 s     | 1.54 GiB      | 0    |
| l12-r3 | typecheck    | 16 s     | 1.55 GiB      | 0    |
| l12-r3 | svelte-check | 36 s     | 2.75 GiB      | 0    |
| l12-r3 | vite-build   | 36 s     | 3.25 GiB      | 0    |
| l12-r3 | browser      | 15 s     | 3.25 GiB      | 0    |

## Worker sweep

| Rep    | Workload | W   | Duration | Peak tree RSS | Exit |
| ------ | -------- | --- | -------- | ------------- | ---- |
| l8-r1  | cargo    | 1   | 121 s    | 1.55 GiB      | 0    |
| l8-r1  | cargo    | 2   | 68 s     | 1.55 GiB      | 0    |
| l8-r1  | cargo    | 4   | 51 s     | 1.55 GiB      | 0    |
| l8-r1  | cargo    | 8   | 53 s     | 1.56 GiB      | 0    |
| l8-r1  | cargo    | 16  | 53 s     | 2.76 GiB      | 0    |
| l8-r1  | browser  | 1   | 19 s     | 1.86 GiB      | 0    |
| l8-r1  | browser  | 2   | 13 s     | 2.58 GiB      | 0    |
| l8-r1  | browser  | 4   | 13 s     | 3.37 GiB      | 0    |
| l8-r1  | browser  | 8   | 17 s     | 4.74 GiB      | 0    |
| l8-r1  | browser  | 16  | 20 s     | 6.98 GiB      | 0    |
| l8-r2  | cargo    | 1   | 133 s    | 1.52 GiB      | 0    |
| l8-r2  | cargo    | 2   | 75 s     | 1.55 GiB      | 0    |
| l8-r2  | cargo    | 4   | 58 s     | 1.54 GiB      | 0    |
| l8-r2  | cargo    | 8   | 57 s     | 1.57 GiB      | 0    |
| l8-r2  | cargo    | 16  | 56 s     | 2.54 GiB      | 0    |
| l8-r2  | browser  | 1   | 24 s     | 2.01 GiB      | 0    |
| l8-r2  | browser  | 2   | 14 s     | 2.50 GiB      | 0    |
| l8-r2  | browser  | 4   | 16 s     | 3.42 GiB      | 0    |
| l8-r2  | browser  | 8   | 20 s     | 4.85 GiB      | 0    |
| l8-r2  | browser  | 16  | 24 s     | 7.24 GiB      | 0    |
| l12-r1 | cargo    | 1   | 163 s    | 1.55 GiB      | 0    |
| l12-r1 | cargo    | 2   | 92 s     | 1.55 GiB      | 0    |
| l12-r1 | cargo    | 4   | 76 s     | 1.55 GiB      | 0    |
| l12-r1 | cargo    | 8   | 72 s     | 1.72 GiB      | 0    |
| l12-r1 | cargo    | 16  | 72 s     | 2.87 GiB      | 0    |
| l12-r1 | browser  | 1   | 28 s     | 2.00 GiB      | 0    |
| l12-r1 | browser  | 2   | 21 s     | 2.53 GiB      | 0    |
| l12-r1 | browser  | 4   | 19 s     | 3.30 GiB      | 0    |
| l12-r1 | browser  | 8   | 26 s     | 5.18 GiB      | 0    |
| l12-r1 | browser  | 16  | 30 s     | 6.76 GiB      | 0    |
| l12-r2 | cargo    | 1   | 119 s    | 1.55 GiB      | 0    |
| l12-r2 | cargo    | 2   | 67 s     | 1.53 GiB      | 0    |
| l12-r2 | cargo    | 4   | 49 s     | 1.55 GiB      | 0    |
| l12-r2 | cargo    | 8   | 48 s     | 1.51 GiB      | 0    |
| l12-r2 | cargo    | 16  | 48 s     | 2.69 GiB      | 0    |
| l12-r2 | browser  | 1   | 17 s     | 2.13 GiB      | 0    |
| l12-r2 | browser  | 2   | 12 s     | 2.54 GiB      | 0    |
| l12-r2 | browser  | 4   | 13 s     | 3.19 GiB      | 0    |
| l12-r2 | browser  | 8   | 16 s     | 5.03 GiB      | 0    |
| l12-r2 | browser  | 16  | 22 s     | 6.99 GiB      | 0    |
| l12-r3 | cargo    | 1   | 133 s    | 1.55 GiB      | 0    |
| l12-r3 | cargo    | 2   | 74 s     | 1.52 GiB      | 0    |
| l12-r3 | cargo    | 4   | 59 s     | 1.57 GiB      | 0    |
| l12-r3 | cargo    | 8   | 59 s     | 1.75 GiB      | 0    |
| l12-r3 | cargo    | 16  | 58 s     | 2.78 GiB      | 0    |
| l12-r3 | browser  | 1   | 23 s     | 2.08 GiB      | 0    |
| l12-r3 | browser  | 2   | 18 s     | 2.44 GiB      | 0    |
| l12-r3 | browser  | 4   | 16 s     | 3.30 GiB      | 0    |
| l12-r3 | browser  | 8   | 21 s     | 5.02 GiB      | 0    |
| l12-r3 | browser  | 16  | 27 s     | 6.81 GiB      | 0    |

| Workload | RSS per worker (fit) | Peak at W=16 | W=32 (estimate) |
| -------- | -------------------- | ------------ | --------------- |
| cargo    | 0.08 GiB             | 2.87 GiB     | 3.84 GiB        |
| browser  | 0.33 GiB             | 7.24 GiB     | 12.41 GiB       |

Largest single-job peak at W=16: **7.24 GiB** → cap **7.50 GiB** (current 4.00 GiB). The W=32 column is an extrapolation and not used.

## Ramp by concurrent lanes

### l8-r1

| Lanes | Seconds | Min avail | Median avail | Max PSI full10 | Max PSI some10 | Max CPU some10 | Probe p95 ms | Probe max ms | Unhealthy s | Max load RSS |
| ----- | ------- | --------- | ------------ | -------------- | -------------- | -------------- | ------------ | ------------ | ----------- | ------------ |
| 0     | 60      | 14.35 GiB | 14.62 GiB    | 0.0            | 0.0            | 1.6            | 0.3          | 2            | 0           | 0.00 GiB     |
| 1     | 120     | 10.95 GiB | 13.89 GiB    | 0.0            | 0.0            | 25.9           | 2.0          | 6            | 0           | 3.43 GiB     |
| 2     | 120     | 9.22 GiB  | 11.91 GiB    | 0.0            | 0.0            | 50.7           | 3.1          | 10           | 0           | 5.38 GiB     |
| 3     | 120     | 7.05 GiB  | 10.74 GiB    | 1.5            | 2.0            | 83.6           | 3.5          | 14           | 0           | 7.65 GiB     |
| 4     | 120     | 4.51 GiB  | 10.08 GiB    | 1.9            | 3.0            | 92.8           | 4.0          | 13           | 0           | 10.26 GiB    |
| 5     | 119     | 4.04 GiB  | 8.71 GiB     | 2.3            | 5.0            | 97.5           | 4.7          | 15           | 0           | 10.65 GiB    |
| 6     | 120     | 1.55 GiB  | 6.86 GiB     | 1.8            | 5.5            | 97.8           | 5.5          | 15           | 0           | 13.27 GiB    |
| 7     | 119     | 5.86 GiB  | 8.76 GiB     | 0.7            | 1.5            | 98.8           | 6.2          | 15           | 0           | 9.50 GiB     |
| 8     | 240     | 2.89 GiB  | 8.25 GiB     | 2.3            | 5.9            | 99.0           | 6.4          | 22           | 0           | 12.28 GiB    |

| Workload     | Completed in ramp | Median duration | Solo | Slowdown |
| ------------ | ----------------- | --------------- | ---- | -------- |
| cargo        | 13                | 2 s             | 50 s | 0.0×     |
| typecheck    | 15                | 42 s            | 12 s | 3.6×     |
| svelte-check | 14                | 110 s           | 29 s | 3.8×     |
| vite-build   | 11                | 85 s            | 29 s | 3.0×     |
| browser      | 11                | 29 s            | 13 s | 2.3×     |

### l8-r2

| Lanes | Seconds | Min avail | Median avail | Max PSI full10 | Max PSI some10 | Max CPU some10 | Probe p95 ms | Probe max ms | Unhealthy s | Max load RSS |
| ----- | ------- | --------- | ------------ | -------------- | -------------- | -------------- | ------------ | ------------ | ----------- | ------------ |
| 0     | 60      | 14.50 GiB | 14.62 GiB    | 0.0            | 0.0            | 18.2           | 0.3          | 3            | 0           | 0.00 GiB     |
| 1     | 120     | 11.02 GiB | 13.82 GiB    | 0.0            | 0.0            | 31.3           | 1.8          | 6            | 0           | 3.50 GiB     |
| 2     | 120     | 9.05 GiB  | 11.98 GiB    | 0.2            | 0.2            | 62.9           | 3.0          | 13           | 0           | 5.47 GiB     |
| 3     | 119     | 6.17 GiB  | 11.21 GiB    | 1.9            | 2.7            | 71.5           | 3.4          | 12           | 0           | 8.47 GiB     |
| 4     | 120     | 5.39 GiB  | 9.98 GiB     | 0.6            | 0.8            | 90.3           | 3.9          | 14           | 0           | 9.35 GiB     |
| 5     | 120     | 3.99 GiB  | 7.70 GiB     | 0.0            | 0.0            | 97.4           | 4.2          | 12           | 0           | 10.63 GiB    |
| 6     | 120     | 5.59 GiB  | 9.37 GiB     | 0.0            | 0.0            | 98.7           | 5.9          | 16           | 0           | 9.24 GiB     |
| 7     | 120     | 3.31 GiB  | 8.41 GiB     | 0.9            | 2.2            | 98.9           | 6.0          | 13           | 0           | 11.46 GiB    |
| 8     | 239     | 2.27 GiB  | 8.44 GiB     | 1.2            | 3.0            | 99.0           | 6.0          | 48           | 0           | 12.93 GiB    |

| Workload     | Completed in ramp | Median duration | Solo | Slowdown |
| ------------ | ----------------- | --------------- | ---- | -------- |
| cargo        | 11                | 58 s            | 60 s | 1.0×     |
| typecheck    | 12                | 63 s            | 15 s | 4.1×     |
| svelte-check | 13                | 112 s           | 36 s | 3.1×     |
| vite-build   | 8                 | 77 s            | 35 s | 2.2×     |
| browser      | 9                 | 36 s            | 15 s | 2.3×     |

### l12-r1

| Lanes | Seconds | Min avail | Median avail | Max PSI full10 | Max PSI some10 | Max CPU some10 | Probe p95 ms | Probe max ms | Unhealthy s | Max load RSS |
| ----- | ------- | --------- | ------------ | -------------- | -------------- | -------------- | ------------ | ------------ | ----------- | ------------ |
| 0     | 60      | 14.54 GiB | 14.73 GiB    | 0.0            | 0.0            | 3.6            | 0.3          | 0            | 0           | 0.00 GiB     |
| 1     | 120     | 11.33 GiB | 14.09 GiB    | 0.0            | 0.0            | 26.5           | 2.2          | 9            | 0           | 3.24 GiB     |
| 2     | 120     | 9.30 GiB  | 12.14 GiB    | 0.0            | 0.0            | 70.0           | 3.0          | 12           | 0           | 5.43 GiB     |
| 3     | 120     | 8.33 GiB  | 10.55 GiB    | 0.4            | 0.5            | 79.8           | 3.5          | 13           | 0           | 6.38 GiB     |
| 4     | 120     | 7.40 GiB  | 9.69 GiB     | 1.4            | 2.1            | 89.2           | 3.8          | 14           | 0           | 7.40 GiB     |
| 5     | 120     | 5.42 GiB  | 8.53 GiB     | 2.7            | 4.4            | 96.6           | 4.5          | 13           | 0           | 9.76 GiB     |
| 6     | 120     | 1.43 GiB  | 7.17 GiB     | 3.0            | 3.9            | 98.6           | 5.5          | 15           | 0           | 13.53 GiB    |
| 7     | 119     | 1.76 GiB  | 5.98 GiB     | 1.1            | 2.9            | 98.9           | 6.0          | 21           | 0           | 13.28 GiB    |
| 8     | 120     | 4.11 GiB  | 8.35 GiB     | 0.2            | 0.8            | 98.9           | 6.1          | 24           | 0           | 11.05 GiB    |
| 9     | 120     | 2.14 GiB  | 8.30 GiB     | 1.2            | 6.4            | 99.0           | 6.8          | 18           | 0           | 12.67 GiB    |
| 10    | 119     | 2.14 GiB  | 7.57 GiB     | 2.4            | 9.6            | 98.9           | 6.2          | 20           | 0           | 13.52 GiB    |
| 11    | 120     | 3.11 GiB  | 4.69 GiB     | 3.3            | 6.6            | 99.0           | 6.8          | 19           | 0           | 12.64 GiB    |
| 12    | 239     | 1.91 GiB  | 4.34 GiB     | 5.3            | 15.4           | 99.0           | 8.8          | 52           | 0           | 14.45 GiB    |

| Workload     | Completed in ramp | Median duration | Solo | Slowdown |
| ------------ | ----------------- | --------------- | ---- | -------- |
| cargo        | 10                | 80 s            | 78 s | 1.0×     |
| typecheck    | 13                | 118 s           | 21 s | 5.8×     |
| svelte-check | 12                | 179 s           | 48 s | 3.7×     |
| vite-build   | 9                 | 136 s           | 46 s | 3.0×     |
| browser      | 10                | 89 s            | 19 s | 4.7×     |

### l12-r2

| Lanes | Seconds | Min avail | Median avail | Max PSI full10 | Max PSI some10 | Max CPU some10 | Probe p95 ms | Probe max ms | Unhealthy s | Max load RSS |
| ----- | ------- | --------- | ------------ | -------------- | -------------- | -------------- | ------------ | ------------ | ----------- | ------------ |
| 1     | 60      | 13.04 GiB | 14.08 GiB    | 0.0            | 0.0            | 13.9           | 1.9          | 5            | 0           | 1.52 GiB     |
| 2     | 60      | 9.79 GiB  | 11.94 GiB    | 0.6            | 0.8            | 21.6           | 3.1          | 11           | 0           | 4.86 GiB     |
| 3     | 60      | 8.50 GiB  | 10.78 GiB    | 1.2            | 1.6            | 72.8           | 3.3          | 10           | 0           | 6.20 GiB     |
| 4     | 60      | 8.46 GiB  | 10.15 GiB    | 0.9            | 1.5            | 85.2           | 5.0          | 11           | 0           | 6.79 GiB     |
| 5     | 60      | 6.46 GiB  | 9.44 GiB     | 1.7            | 3.6            | 97.8           | 5.2          | 13           | 0           | 8.67 GiB     |
| 6     | 60      | 6.91 GiB  | 9.51 GiB     | 0.5            | 1.3            | 98.3           | 6.7          | 13           | 0           | 9.46 GiB     |
| 7     | 59      | 9.50 GiB  | 9.94 GiB     | 0.0            | 0.0            | 98.8           | 7.8          | 20           | 0           | 6.47 GiB     |
| 8     | 60      | 8.37 GiB  | 8.69 GiB     | 0.2            | 0.8            | 99.0           | 7.7          | 18           | 0           | 7.51 GiB     |
| 9     | 60      | 8.11 GiB  | 9.18 GiB     | 2.9            | 9.1            | 98.9           | 8.2          | 210          | 0           | 7.67 GiB     |
| 10    | 95      | 0.18 GiB  | 3.66 GiB     | 27.7           | 39.8           | 98.8           | 34.9         | 1208         | 4           | 14.47 GiB    |
| 11    | 119     | 0.61 GiB  | 2.09 GiB     | 19.4           | 39.9           | 98.8           | 7.7          | 104          | 0           | 15.80 GiB    |
| 12    | 240     | 0.22 GiB  | 2.50 GiB     | 13.9           | 30.9           | 99.0           | 7.7          | 36           | 0           | 14.56 GiB    |

| Workload     | Completed in ramp | Median duration | Solo | Slowdown |
| ------------ | ----------------- | --------------- | ---- | -------- |
| cargo        | 8                 | 221 s           | 62 s | 3.6×     |
| typecheck    | 11                | 156 s           | 13 s | 12.2×    |
| svelte-check | 7                 | 121 s           | 30 s | 4.1×     |
| vite-build   | 6                 | 96 s            | 29 s | 3.3×     |
| browser      | 8                 | 53 s            | 13 s | 4.1×     |

### l12-r3

| Lanes | Seconds | Min avail | Median avail | Max PSI full10 | Max PSI some10 | Max CPU some10 | Probe p95 ms | Probe max ms | Unhealthy s | Max load RSS |
| ----- | ------- | --------- | ------------ | -------------- | -------------- | -------------- | ------------ | ------------ | ----------- | ------------ |
| 0     | 60      | 14.57 GiB | 14.72 GiB    | 0.0            | 0.0            | 6.3            | 0.3          | 1            | 0           | 0.00 GiB     |
| 1     | 120     | 11.47 GiB | 13.94 GiB    | 0.0            | 0.0            | 22.9           | 1.7          | 6            | 0           | 3.18 GiB     |
| 2     | 120     | 9.72 GiB  | 11.99 GiB    | 0.0            | 0.0            | 57.5           | 2.5          | 21           | 0           | 4.84 GiB     |
| 3     | 120     | 6.81 GiB  | 10.51 GiB    | 1.3            | 1.8            | 81.5           | 3.0          | 10           | 0           | 7.83 GiB     |
| 4     | 120     | 6.16 GiB  | 10.19 GiB    | 1.7            | 2.4            | 92.0           | 3.1          | 12           | 0           | 8.58 GiB     |
| 5     | 120     | 5.19 GiB  | 8.86 GiB     | 0.7            | 1.7            | 98.2           | 3.8          | 20           | 0           | 9.59 GiB     |
| 6     | 119     | 2.53 GiB  | 9.26 GiB     | 1.4            | 3.4            | 98.7           | 5.0          | 12           | 0           | 12.46 GiB    |
| 7     | 120     | 4.03 GiB  | 8.47 GiB     | 2.3            | 5.0            | 98.7           | 6.0          | 20           | 0           | 11.50 GiB    |
| 8     | 120     | 0.83 GiB  | 6.50 GiB     | 1.7            | 7.3            | 99.0           | 6.0          | 14           | 0           | 14.41 GiB    |
| 9     | 119     | 1.21 GiB  | 3.81 GiB     | 2.9            | 12.9           | 99.0           | 5.6          | 139          | 0           | 14.18 GiB    |
| 10    | 120     | 2.10 GiB  | 4.28 GiB     | 6.1            | 21.3           | 98.9           | 6.2          | 19           | 0           | 13.69 GiB    |
| 11    | 120     | 1.62 GiB  | 2.74 GiB     | 14.7           | 30.8           | 98.9           | 6.2          | 368          | 0           | 14.30 GiB    |
| 12    | 239     | 1.36 GiB  | 3.38 GiB     | 8.3            | 18.2           | 99.0           | 6.8          | 101          | 0           | 14.52 GiB    |

| Workload     | Completed in ramp | Median duration | Solo | Slowdown |
| ------------ | ----------------- | --------------- | ---- | -------- |
| cargo        | 15                | 2 s             | 72 s | 0.0×     |
| typecheck    | 14                | 103 s           | 16 s | 6.6×     |
| svelte-check | 14                | 242 s           | 36 s | 6.6×     |
| vite-build   | 15                | 151 s           | 36 s | 4.2×     |
| browser      | 17                | 68 s            | 15 s | 4.5×     |

## Unhealthy episodes

Times relative to the settle phase start.

| Rep    | Onset  | Length | Lanes started | Avail at onset | PSI full10 at onset |
| ------ | ------ | ------ | ------------- | -------------- | ------------------- |
| l12-r2 | 1053 s | 6 s    | 12            | 0.21 GiB       | 16.4                |

## Selection

Current: 15.0 % · 20 · 30 s · 1/1 · 2 · 2

Chosen: **5.0 % · 20 · 30 s · 1/1 · 0 · 0**, cap 7.50 GiB — adjusted.

| Floor (% RAM) | PSI full max | Hold | Covered | Harmless starts blocked | Flaps |
| ------------- | ------------ | ---- | ------- | ----------------------- | ----- |
| 5.0 %         | 20           | 30 s | 1/1     | 0                       | 0     |
| 5.0 %         | 15           | 30 s | 1/1     | 0                       | 0     |
| 7.5 %         | 20           | 15 s | 1/1     | 0                       | 0     |
| 5.0 %         | 30           | 30 s | 1/1     | 0                       | 0     |
| 7.5 %         | 15           | 15 s | 1/1     | 0                       | 0     |
| 7.5 %         | 30           | 15 s | 1/1     | 0                       | 0     |
| 5.0 %         | 20           | 60 s | 1/1     | 0                       | 0     |
| 5.0 %         | 40           | 30 s | 1/1     | 0                       | 0     |
| 7.5 %         | 40           | 15 s | 1/1     | 0                       | 0     |
| 5.0 %         | 30           | 60 s | 1/1     | 0                       | 0     |
| 5.0 %         | 40           | 60 s | 1/1     | 0                       | 0     |
| 7.5 %         | 20           | 30 s | 1/1     | 1                       | 0     |
| 7.5 %         | 15           | 30 s | 1/1     | 1                       | 0     |
| 7.5 %         | 30           | 30 s | 1/1     | 1                       | 0     |
| 5.0 %         | 10           | 30 s | 1/1     | 1                       | 0     |
