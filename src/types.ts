/**
 * OneBot 协议类型定义
 */

export interface OneBotMessage {
  post_type: string;
  message_type?: "private" | "group";
  message_id?: number;
  user_id?: number;
  group_id?: number;
  message?: Array<{ type: string; data?: Record<string, unknown> }>;
  raw_message?: string;
  self_id?: number;
  time?: number;
  /** notice 事件类型：group_increase / notify / poke 等 */
  notice_type?: string;
  /** notice 子类型：notify 下的 poke（戳一戳）等 */
  sub_type?: string;
  /** 戳一戳事件中被戳者的 QQ 号 */
  target_id?: number;
  sender?: {
    user_id?: number;
    nickname?: string;
    card?: string;
  };
  [key: string]: unknown;
}

export interface OneBotAccountConfig {
  accountId?: string;
  type: "forward-websocket" | "backward-websocket";
  host: string;
  port: number;
  accessToken?: string;
  path?: string;
  enabled?: boolean;
}
