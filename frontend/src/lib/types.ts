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
  voice_input_enabled: boolean;
  speak_responses: boolean;
  voice_name: string;
  speech_rate: number;
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
  | { event: "reset"; data: Record<string, never> }
  | { event: "reply_done"; data: Message };
