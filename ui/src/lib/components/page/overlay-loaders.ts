/**
 * Code-split loaders for overlays that are not on the first screen (#3233). One memoized loader
 * per component: `LazyMount` mounts through it and `+page` idle-prefetches the common ones.
 */
import { lazy } from "#lib/lazy-component.js";

export const loadNewTask = lazy(() => import("#lib/components/NewTask.svelte"));
export const loadSettings = lazy(() => import("#lib/components/Settings.svelte"));
export const loadUsage = lazy(() => import("#lib/components/Usage.svelte"));
export const loadCloneRepo = lazy(() => import("#lib/components/CloneRepo.svelte"));
export const loadForkRepo = lazy(() => import("#lib/components/ForkRepo.svelte"));
export const loadNewProject = lazy(() => import("#lib/components/NewProject.svelte"));
export const loadBroadcastDialog = lazy(() => import("#lib/components/BroadcastDialog.svelte"));
export const loadCommandBar = lazy(() => import("#lib/components/CommandBar.svelte"));
export const loadRetryDialog = lazy(() => import("#lib/components/RetryDialog.svelte"));
export const loadAmendTaskDialog = lazy(() => import("#lib/components/AmendTaskDialog.svelte"));
export const loadDecommissionPrDialog = lazy(
  () => import("#lib/components/DecommissionPrDialog.svelte"),
);
export const loadEpicDiagnoseEntry = lazy(() => import("#lib/components/EpicDiagnoseEntry.svelte"));
export const loadClearMergedDialog = lazy(() => import("#lib/components/ClearMergedDialog.svelte"));
export const loadMergeTrainConfirmDialog = lazy(
  () => import("#lib/components/MergeTrainConfirmDialog.svelte"),
);
export const loadBacklogOverlay = lazy(() => import("#lib/components/BacklogOverlay.svelte"));
export const loadUpdateModal = lazy(() => import("#lib/components/UpdateModal.svelte"));
export const loadHerdrUpdateModal = lazy(() => import("#lib/components/HerdrUpdateModal.svelte"));
export const loadCodexUpdateModal = lazy(() => import("#lib/components/CodexUpdateModal.svelte"));
export const loadPluginUpdatesModal = lazy(
  () => import("#lib/components/PluginUpdatesModal.svelte"),
);
export const loadWhatsNew = lazy(() => import("#lib/components/WhatsNew.svelte"));
export const loadFableArrival = lazy(() => import("#lib/components/FableArrival.svelte"));
export const loadOnboarding = lazy(() => import("#lib/components/Onboarding.svelte"));
export const loadDoneRecapPanel = lazy(() => import("#lib/components/DoneRecapPanel.svelte"));
export const loadRemoteSessionDetail = lazy(
  () => import("#lib/components/RemoteSessionDetail.svelte"),
);
export const loadReposSheet = lazy(() => import("#lib/components/ReposSheet.svelte"));
