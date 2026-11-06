export type Role = "user" | "assistant" | "system";
export type MessageStatus = "complete" | "streaming" | "cancelled" | "error";

export interface User {
  id: string;
  username: string;
  display_name: string;
  created_at: string;
}

export interface AuthStatus {
  setup_required: boolean;
  setup_token_required: boolean;
}

export interface LoginResponse {
  token: string;
  expires_at: string;
  user: User;
}

export interface Message {
  id: string;
  seq: number;
  role: Role;
  content: string;
  status: MessageStatus;
  model: string | null;
  error: string | null;
  created_at: string;
  memory_ids: string[];
  tools?: ToolExecution[];
}

export type ToolStatus = "preparing" | "pending_approval" | "approved" | "denied" | "running" | "succeeded" | "failed" | "cancelled";
export type PermissionLevel = "automatic" | "restricted" | "sensitive";
export type Decision = "allow" | "ask" | "deny";

export interface ToolExecution {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  tool_use_id: string | null;
  tool_name: string;
  permission_level: PermissionLevel;
  status: ToolStatus;
  summary: string;
  input: Record<string, unknown> | null;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface ToolInfo {
  name: string;
  description: string;
  level: PermissionLevel;
  decision: Decision;
  rule: "tool" | "level" | "default";
  enabled: boolean;
  server: boolean;
}

export interface ToolsOverview {
  tools: ToolInfo[];
  levels: { level: PermissionLevel; decision: Decision; is_default: boolean }[];
  workspace_dir: string;
  tools_enabled: boolean;
  web_search_enabled: boolean;
  limits: Record<string, number>;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  messages: Message[];
}

export interface Preferences {
  assistant_name: string;
  model: string;
  max_output_tokens: number;
  effort: Effort;
  memory_enabled: boolean;
  tools_enabled: boolean;
  web_search_enabled: boolean;
  voice_input_enabled: boolean;
  speak_responses: boolean;
  voice_name: string;
  speech_rate: number;
  voice_provider: "browser";
  voice_language: string;
  voice_auto_send: boolean;
  voice_conversation_mode: boolean;
  send_on_enter: boolean;
}

export type Effort = "" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface UsageRow {
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  web_search_requests: number;
  estimated_cost_usd: number | null;
}

export interface UsageSummary {
  days: number;
  totals: UsageRow;
  by_model: UsageRow[];
}

export interface ServerInfo {
  version: string;
  phase: number;
  ai_provider: "claude" | "unconfigured";
  ai_configured: boolean;
  default_model: string;
  default_max_output_tokens: number;
  refusal_fallback: boolean;
  models: ModelOption[];
}

export interface SettingsResponse {
  preferences: Preferences;
  server: ServerInfo;
}

export interface Backup {
  filename: string;
  size_bytes: number;
  created_at: string;
}

export type StreamEvent =
  | { event: "user_message"; data: Message }
  | { event: "conversation"; data: { id: string; title: string } }
  | { event: "reply_start"; data: Message }
  | { event: "delta"; data: { text: string } }
  | { event: "reset"; data: { text?: string } }
  | { event: "tool_start"; data: { id: string; name: string; server: boolean } }
  | { event: "tool_call"; data: ToolExecution }
  | { event: "tool_result"; data: ToolExecution }
  | { event: "reply_done"; data: Message };

export type MemoryCategory = "preference" | "personal" | "project" | "progress" | "knowledge" | "conversation";
export const MEMORY_CATEGORIES: { id: MemoryCategory; label: string }[] = [
  { id: "preference", label: "Preference" },
  { id: "personal", label: "Personal" },
  { id: "project", label: "Project" },
  { id: "progress", label: "Progress" },
  { id: "knowledge", label: "Knowledge" },
  { id: "conversation", label: "Conversation" },
];

export interface Memory {
  id: string;
  category: MemoryCategory;
  content: string;
  importance: number;
  approved: boolean;
  source: "user" | "assistant";
  project_id: string | null;
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface MemoryList {
  items: Memory[];
  total: number;
  counts: Record<string, number>;
}

export interface MemoryHistoryEntry {
  id: string;
  memory_id: string;
  action: "create" | "suggest" | "update" | "approve" | "reject" | "delete";
  old_content: string | null;
  new_content: string | null;
  created_at: string;
}

export type ProjectStatus = "active" | "paused" | "completed" | "archived";

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  progress_notes: string;
  created_at: string;
  updated_at: string;
  memory_count: number;
}

export interface MemoryInput {
  content: string;
  category: MemoryCategory;
  importance: number;
  project_id: string | null;
  allow_near_duplicate?: boolean;
}

export interface DesktopApp {
  id: string;
  name: string;
  path: string;
  args: string[];
  allow_target: boolean;
  description: string;
}

export interface AutomationStatus {
  desktop_enabled: boolean;
  desktop_reason: string | null;
  platform: string;
  browser_enabled: boolean;
  browser_headless: boolean;
  browser_private_network: boolean;
  browser_open_url: string | null;
}
