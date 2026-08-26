const path = require("path");

module.exports = {
  BOT_NAME: "BOT BUILD APK BY Ridzz",
  BOT_VERSION: "3.0",
  
  // Token bot
  BOT_TOKEN: process.env.BOT_TOKEN || "8966396235:AAEeyPzPqz1U29_fvGpLD4RKwHduIQf1hKo",
  
  // API Telegram
  API_ID: parseInt(process.env.API_ID || "38496622"),
  API_HASH: process.env.API_HASH || "cd040393e52409f15922421a91fd34ed",
  
  // Owner & Admin
  OWNER_ID: parseInt(process.env.OWNER_ID || "8859497242"),
  ADMIN_IDS: (process.env.ADMIN_IDS || "8859497242").split(",").map(Number).filter(Boolean),
  
  // Channel
  CHANNEL_USERNAME: process.env.CHANNEL_USERNAME || "logbuildridz",
  CHANNEL_USERNAME2: process.env.CHANNEL_USERNAME2 || "logbuild3",
  CHANNEL_USERNAME3: process.env.CHANNEL_USERNAME3 || "",
  CHANNEL_USERNAME4: process.env.CHANNEL_USERNAME4 || "",
  CHANNEL_USERNAME5: process.env.CHANNEL_USERNAME5 || "",
  CHANNEL_USERNAME6: process.env.CHANNEL_USERNAME6 || "",
  
  // GitHub & Vercel
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || "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",
  GITHUB_USERNAME: process.env.GITHUB_USERNAME || "zenoss2311",
  VERCEL_TOKEN: process.env.VERCEL_TOKEN || "vcp_6CT9iTZ7LfG6AYd9Dr0yj0ALR9m8l8AHx6KiNMl1Ayudjc27IP3Gd0in",
  VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID || "team_2sxYT90u2v8CJbAZ2F8FW7za",
  
  // PHOTO - PAKAI FILE LOKAL
  WELCOME_PHOTO: path.join(__dirname, "images", "welcome.jpg"),
  PHOTO_BUILD_APK: path.join(__dirname, "images", "build.jpg"),
  PHOTO_WEB2APK: path.join(__dirname, "images", "web2apk.jpg"),
  PHOTO_DEPLOY_WEB: path.join(__dirname, "images", "deploy.jpg"),
  PHOTO_ENC_HTML: path.join(__dirname, "images", "enc_html.jpg"),
  PHOTO_ENC_JS: path.join(__dirname, "images", "enc_js.jpg"),
  PHOTO_MOD_DOMAIN: path.join(__dirname, "images", "mod_domain.jpg"),
  PHOTO_MOD_COLOR: path.join(__dirname, "images", "mod_color.jpg"),
  PHOTO_MOD_ICON: path.join(__dirname, "images", "mod_icon.jpg"),
  PHOTO_MOD_NAME: path.join(__dirname, "images", "mod_name.jpg"),
  PHOTO_NEW_USER: path.join(__dirname, "images", "new_user.jpg"),
  PHOTO_REPORT_BUG: path.join(__dirname, "images", "report.jpg"),
  
  // Directories
  TMP_DIR: "./tmp",
  
  // Build settings
  BUILD_TIMEOUT_MS: 30 * 60 * 1000,
  POLL_INTERVAL_MS: 7000,
  WEB2APK_MAINTENANCE: false,

  // Panel Hosting (buat fitur Create Panel Free — reward referral)
  // Isi sesuai panel Pterodactyl kamu.
  PANEL: {
    domain: process.env.PANEL_DOMAIN || "https://ISI_DOMAIN_PANEL_LU",
    apikey: process.env.PANEL_APIKEY || "ISI_APPLICATION_API_KEY_LU",
    nestId: parseInt(process.env.PANEL_NEST_ID || "5"),
    eggId: parseInt(process.env.PANEL_EGG_ID || "15"),
    locationId: parseInt(process.env.PANEL_LOCATION_ID || "1"),
    startup: "if [[ -d .git ]] && [[ {{AUTO_UPDATE}} == \"1\" ]]; then git pull; fi; if [[ ! -z ${NODE_PACKAGES} ]]; then /usr/local/bin/npm install ${NODE_PACKAGES}; fi; if [[ ! -z ${UNNODE_PACKAGES} ]]; then /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; if [[ ! -z ${CUSTOM_ENVIRONMENT_VARIABLES} ]]; then vars=$(echo ${CUSTOM_ENVIRONMENT_VARIABLES} | tr \";\" \"\\n\"); for line in $vars; do export $line; done fi; /usr/local/bin/${CMD_RUN};",
    image: process.env.PANEL_IMAGE || "ghcr.io/parkervcp/yolks:nodejs_24",
  },
};