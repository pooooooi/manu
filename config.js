window.APP_CONFIG = {
    csvUrl:
        "https://docs.google.com/spreadsheets/d/1dNk8uLhzl06UJeIsMRYoyLd_MAoHuIpV-qqYIyf8ZS8/export?format=csv&gid=100058082",
    endpoint:
        "https://script.google.com/macros/s/AKfycbyrro2x2Ct_1Bl0a8HEy2itDDv1cPEHpzTCtIiKxuoaPWmCbPnm-0Yr7RnOFtPEM2sm/exec",
    // Customer screen performance tuning.
    jsonpTimeoutMs: 5000,
    orderAckTimeoutMs: 8000,
    orderAckPollIntervalMs: 350,
    quickOrderAckTimeoutMs: 2500,
    quickOrderAckPollIntervalMs: 250,
    immediateSubmitMode: 1,
    // 1: 再送キュー有効 / 0: 無効（推奨: 0）
    resendQueueEnabled: 0,
    skipStorePreflightInImmediateMode: 1,
    skipGroupPreflightInImmediateMode: 1,
    // Startup retry batch size for pending orders.
    startupRetryBatchSize: 3,
    // Staff screen can use separate token/property if needed.
    staffEndpoint:
        "https://script.google.com/macros/s/AKfycbyrro2x2Ct_1Bl0a8HEy2itDDv1cPEHpzTCtIiKxuoaPWmCbPnm-0Yr7RnOFtPEM2sm/exec",
    staffToken: "test",
    // Staff screen performance tuning.
    staffJsonpTimeoutMs: 5000,
    staffVerifyTimeoutMs: 7000,
    staffVerifyPollIntervalMs: 350,
    staffAutoRefreshIntervalMs: 4000,
    // 新規注文アラート（スタッフ画面）
    staffNewOrderSoundEnabled: 1,
    staffDesktopNotificationEnabled: 1,
    staffTitleBadgeEnabled: 1,
    // 1 にするとスタッフ画面に管理用ID(注文ID/グループID)も表示します。
    showTechnicalIds: 0,
    // Optional: when set, only these table IDs can open/order.
    // allowedTables: ["T01", "T02", "T03"]
};
