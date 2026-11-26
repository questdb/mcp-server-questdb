const PER_TOOL_TIMEOUT_MS: Record<string, number> = {
  run_cell: 300_000,
  run_query: 300_000,
  apply_notebook_state: 300_000,
  create_notebook: 15_000,
  add_cell: 15_000,
  update_cell: 15_000,
  delete_cell: 15_000,
  duplicate_cell: 15_000,
  move_cell_up: 15_000,
  move_cell_down: 15_000,
  set_layout_mode: 15_000,
  set_cell_layout: 15_000,
  set_cell_mode: 15_000,
  set_cell_chart_config: 15_000,
  set_cell_autorefresh: 15_000,
  set_cell_view_maximized: 15_000,
  set_cell_maximized: 15_000,
  list_cells: 15_000,
  get_cell: 15_000,
  get_notebook_state: 15_000,
  get_workspace_state: 15_000,
  get_recent_user_actions: 15_000,
}

const DEFAULT_TOOL_TIMEOUT_MS = 15_000

export const toolDeadlineMs = (toolName: string): number =>
  PER_TOOL_TIMEOUT_MS[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS
