// Shared test data for the crash-guard tests.
import type { SnapPane } from "../snapshot";

export const pane = (o: Partial<SnapPane> & { key: string }): SnapPane => ({
  herdr: "default", workspaceId: "w1", workspace: "1", tabId: `t-${o.key}`, tab: "", tabNumber: 1, paneId: o.key, cwd: "/tmp", agent: "claude",
  title: o.key, project: "p", status: "idle", empty: false, ...o,
});
