/// <reference types="@cloudflare/workers-types" />

export interface Env {
  APP_ENV: string;

  DB: D1Database;

  // LINE channel credentials (router 全体で 1 セット)
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;

  // 子 bot 個別の webhook 共有 secret / service token
  ARCHIVE_WEBHOOK_SECRET?: string;
  ATTENDANCE_WEBHOOK_SECRET?: string;
  ATTENDANCE_SERVICE_TOKEN?: string;
  REMINDER_WEBHOOK_SECRET?: string;
  REMINDER_SERVICE_TOKEN?: string;
}
