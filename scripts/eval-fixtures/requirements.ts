// Labelled fixtures for reading a task's requirements from its description (issue #2773).
//
// The first block is the issue's table, verbatim where it gives a prompt; the rest round it out:
// mentions that must NOT call for Xcode, a task carried by its issue alone, English variants, and
// two descriptions that must make New Task ask instead of guess. `scripts/measure-requirements.ts`
// runs them against the live helper; `test/requirements-llm.test.ts` runs them through the
// pipeline with a stubbed helper.

import type { Capability } from "../../src/remote-instances/capabilities";
import type { TaskText } from "../../src/requirements-classify-core";

export interface RequirementsFixture extends TaskText {
  id: string;
  /** The requirements a correct read derives (sorted), or "unclear": the operator is asked. */
  expect: Capability[] | "unclear";
}

export const REQUIREMENTS_FIXTURES: readonly RequirementsFixture[] = [
  {
    id: "macos-app-xcode",
    prompt: "Baue die macOS-App und prüfe sie mit Xcode",
    expect: ["xcode"],
  },
  { id: "macos-app-extend", prompt: "Erweitere die native macOS-App", expect: ["xcode"] },
  {
    id: "ios-view",
    prompt: "Implementiere die Ansicht in der iOS-App",
    expect: ["sdk:ios", "xcode"],
  },
  { id: "android-app", prompt: "Ändere die Android-App", expect: ["android-sdk"] },
  { id: "web-settings", prompt: "Implementiere die Web-Einstellungen", expect: [] },
  {
    id: "mention-package-swift",
    prompt: "Korrigiere in der README den Link auf Package.swift",
    expect: [],
  },
  {
    id: "mention-mac",
    prompt: "Behebe den Tippfehler in der Installationsanleitung für den Mac",
    expect: [],
  },
  // The repository this runs against has `native/` and `Package.swift`; the helper never sees it.
  {
    id: "web-in-native-repo",
    prompt: "Füge in der Web-UI einen Schalter für den Dunkelmodus hinzu",
    expect: [],
  },
  {
    id: "issue-only-android",
    prompt: "",
    issue: {
      title: "Android: Push-Benachrichtigungen kommen nicht an",
      body: "In der Android-App erscheinen seit dem letzten Update keine Push-Benachrichtigungen mehr.",
    },
    expect: ["android-sdk"],
  },
  { id: "en-macos", prompt: "Build the macOS app and check it in Xcode", expect: ["xcode"] },
  {
    id: "en-android",
    prompt: "Change the login screen of the Android app",
    expect: ["android-sdk"],
  },
  { id: "en-web", prompt: "Add a dark-mode toggle to the web settings page", expect: [] },
  { id: "unclear-app", prompt: "Passe die App an das neue Logo an", expect: "unclear" },
  {
    id: "contradictory",
    prompt: "Baue die iOS-App neu – es geht aber nur um eine Textänderung auf der Website",
    expect: "unclear",
  },
];
