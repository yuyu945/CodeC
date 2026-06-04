import type { PermissionDecision, ToolCall, WorkspacePolicy } from "./types.ts";
import { stringInput } from "./shared.ts";
import { isAllowedShell, isDeniedShell, isKnownTool } from "./tools.ts";
import { isInsideWorkspace } from "./workspace.ts";

export class PermissionManager {
  private readonly options: { allowEdits?: boolean };

  constructor(options: { allowEdits?: boolean } = {}) {
    this.options = options;
  }

  async evaluate(call: ToolCall, workspace: WorkspacePolicy): Promise<PermissionDecision> {
    const snapshot = { cwd: workspace.cwd, policy: "mvp0" };
    if (!isKnownTool(call.name)) return { kind: "deny", reason: "unknown_tool", snapshot };

    if (call.name === "shell") {
      const command = stringInput(call.input.command);
      if (!command) return { kind: "deny", reason: "missing_command", snapshot };
      if (isDeniedShell(command)) return { kind: "deny", reason: "risky_shell_command", snapshot };
      if (isAllowedShell(command)) return { kind: "allow", reason: "read_only_shell_command", snapshot };
      return { kind: "ask", reason: "shell_requires_approval", snapshot };
    }

    const pathValue = stringInput(call.input.path) ?? ".";
    if (!isInsideWorkspace(pathValue, workspace.cwd)) {
      return { kind: "deny", reason: "path_outside_workspace", snapshot };
    }

    if (call.name === "edit_file") {
      return this.options.allowEdits
        ? { kind: "allow", reason: "test_policy_allows_edit", snapshot }
        : { kind: "ask", reason: "edit_requires_approval", snapshot };
    }

    return { kind: "allow", reason: "workspace_read", snapshot };
  }
}
