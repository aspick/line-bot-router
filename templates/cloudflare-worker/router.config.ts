import { defineRouterConfig } from "line-bot-router/config";

export default defineRouterConfig({
  router: {
    infoCommand: "/router info",
    unknownGroupPolicy: "ignore",
    adminUserIds: [
      // 運用開始後はこちらに admin の userId を必ず登録する
    ],
    setup: {
      // 初回セットアップで自分の userId / groupId を調べる時だけ true にして deploy する。
      // /router info の応答に sourceId / groupId / roomId / actorUserId が含まれるため、
      // true のまま運用すると group 内の任意ユーザーから内部 ID が読み出せる情報漏洩になる。
      // 必要な ID を取れたら必ず false (または項目ごと削除) に戻し、`adminUserIds` を埋めること。
      allowInfoCommandWithoutAdmin: false,
    },
    virtualReplyToken: {
      ttlSeconds: 55,
    },
  },

  services: [
    {
      id: "archive",
      name: "Archive Bot",
      endpoint: "https://archive.example.com/line-webhook",
      secretEnv: "ARCHIVE_WEBHOOK_SECRET",
      routing: {
        role: "observe",
        events: ["*"],
      },
      delivery: {
        eventFormat: "line-compatible",
        timing: "async",
        responseMode: "none",
      },
      permissions: {
        receiveMessages: true,
        sendMessages: false,
      },
    },

    {
      id: "attendance",
      name: "Attendance Bot",
      endpoint: "https://attendance.example.com/events",
      secretEnv: "ATTENDANCE_WEBHOOK_SECRET",
      serviceTokenEnv: "ATTENDANCE_SERVICE_TOKEN",
      routing: {
        role: "handle",
        commands: ["/att", "出欠:"],
        postbackNamespace: "attendance",
        mentions: ["出欠bot"],
      },
      delivery: {
        eventFormat: "router-native",
        timing: "sync",
        responseMode: "http-response",
      },
      permissions: {
        receiveMessages: true,
        sendMessages: true,
      },
    },

    {
      id: "legacy-reminder",
      name: "Legacy Reminder Bot",
      endpoint: "https://reminder.example.com/line-webhook",
      secretEnv: "REMINDER_WEBHOOK_SECRET",
      serviceTokenEnv: "REMINDER_SERVICE_TOKEN",
      routing: {
        role: "handle",
        commands: ["/remind", "リマインド:"],
      },
      delivery: {
        eventFormat: "line-compatible",
        timing: "sync",
        responseMode: "messaging-api-proxy",
      },
      proxy: {
        messagingApi: true,
        blobApi: false,
      },
      permissions: {
        receiveMessages: true,
        sendMessages: true,
      },
    },
  ],

  groups: [
    // 例: 特定の groupId だけ enabledServices で絞り込む
    // {
    //   id: "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    //   name: "Chor Doma",
    //   enabledServices: ["archive", "attendance", "legacy-reminder"],
    // },
  ],
});
