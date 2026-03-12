window.APP_CONFIG = {
    csvUrl:
        "https://docs.google.com/spreadsheets/d/1dNk8uLhzl06UJeIsMRYoyLd_MAoHuIpV-qqYIyf8ZS8/export?format=csv&gid=100058082",
    endpoint:
        "https://script.google.com/macros/s/AKfycbyrro2x2Ct_1Bl0a8HEy2itDDv1cPEHpzTCtIiKxuoaPWmCbPnm-0Yr7RnOFtPEM2sm/exec",
    // Startup retry batch size for pending orders.
    startupRetryBatchSize: 3,
    // Staff screen can use separate token/property if needed.
    staffEndpoint:
        "https://script.google.com/macros/s/AKfycbyrro2x2Ct_1Bl0a8HEy2itDDv1cPEHpzTCtIiKxuoaPWmCbPnm-0Yr7RnOFtPEM2sm/exec",
    staffToken: "test",
    // Optional: when set, only these table IDs can open/order.
    // allowedTables: ["T01", "T02", "T03"]
};
