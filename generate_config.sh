#!/bin/bash
#
# generate_config.sh — build-time generator for js/core/Config.js
#
# js/core/Config.js is gitignored (holds the OAuth client id + keys), so it is
# NOT in the repo. Render runs this script at build time to recreate it from
# Environment Variables. The output MUST match the schema the app imports:
#   import Config from '../core/Config.js';   // default export, nested objects
#
# Required Render env vars:
#   GOOGLE_CLIENT_ID   — OAuth 2.0 client ID (…apps.googleusercontent.com)
# Optional:
#   PICKER_API_KEY     — Browser API key with the Picker API enabled
#                        (needed only for importing shared folders)
#
# appId (Cloud project number) is derived from the client ID's leading segment.

set -e

# Derive the Cloud project number from the client ID ("1234-abc...." -> "1234").
APP_ID="${GOOGLE_CLIENT_ID%%-*}"

# Write to the path the code actually imports: js/core/Config.js
cat <<EOF > js/core/Config.js
/**
 * Config.js — GENERATED at build time by generate_config.sh.
 * Do not edit on the server; edit generate_config.sh instead.
 */

function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.keys(obj).forEach(key => deepFreeze(obj[key]));
    return Object.freeze(obj);
}

const Config = deepFreeze({
    google: {
        clientId: '${GOOGLE_CLIENT_ID}',
        scopes: 'https://www.googleapis.com/auth/drive.file',
        pickerApiKey: '${PICKER_API_KEY}',
        appId: '${APP_ID}',
        driveRootFolder: 'Ecological_Monitoring_Data',
    },
    storage: {
        dbName: 'CEM_Toolkit_DB',
        storeName: 'files',
        masterFilename: 'master_data.json',
    },
    watcher: {
        pollInterval: 3000,
        maxStaleAge: 15,
        processingMaxAge: 1800,
        installingMaxAge: 600,
    },
    analysis: {
        githubRepoUrl: 'https://raw.githubusercontent.com/xHrid/cem-scripts-new/refs/heads/main',
    },
    ui: {
        toastDuration: 3000,
    },
    map: {
        defaultCenter: [20, 0],
        defaultZoom: 3,
        minZoom: 3,
        maxZoom: 18,
    },
});

export default Config;
EOF

echo "Configuration file generated successfully at js/core/Config.js"
