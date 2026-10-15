import { m } from "#lib/paraglide/messages.js";
import type {
  AssistantActionGroup,
  AssistantActionLevel,
  AssistantShellLevel,
} from "#lib/types.js";

// Labels for Settings → Assistant, shared by its panel and the assistant panel's chip tooltip.

export function assistantGroupTitle(group: AssistantActionGroup): string {
  switch (group) {
    case "steer":
      return m.settings_assistant_steer_title();
    case "sessions":
      return m.settings_assistant_sessions_title();
    case "approve":
      return m.settings_assistant_approve_title();
    case "automation":
      return m.settings_assistant_automation_title();
  }
}

export function assistantGroupHint(group: AssistantActionGroup): string {
  switch (group) {
    case "steer":
      return m.settings_assistant_steer_hint();
    case "sessions":
      return m.settings_assistant_sessions_hint();
    case "approve":
      return m.settings_assistant_approve_hint();
    case "automation":
      return m.settings_assistant_automation_hint();
  }
}

export function assistantActionLevelLabel(level: AssistantActionLevel): string {
  switch (level) {
    case "off":
      return m.settings_assistant_level_off();
    case "ask":
      return m.settings_assistant_level_ask();
    case "allow":
      return m.settings_assistant_level_allow();
  }
}

export function assistantShellLevelLabel(level: AssistantShellLevel): string {
  switch (level) {
    case "off":
      return m.settings_assistant_level_off();
    case "ask":
      return m.settings_assistant_shell_ask();
    case "read":
      return m.settings_assistant_shell_read();
    case "all":
      return m.settings_assistant_shell_all();
  }
}
