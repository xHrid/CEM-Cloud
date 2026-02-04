import { CONFIG } from './config.js';

let tokenClient;
let accessToken = null;

export function initAuth(onLoginSuccess) {
    if (!window.google) return console.error("Google Script not loaded");

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID, // Loaded from config
        scope: CONFIG.GOOGLE_SCOPES,
        callback: (tokenResponse) => {
            if (tokenResponse.error) return console.error(tokenResponse);
            accessToken = tokenResponse.access_token;
            console.log("🔒 Auth: Logged in");
            if (onLoginSuccess) onLoginSuccess();
        },
    });
}

export function requestLogin() {
    if (accessToken) return;
    tokenClient.requestAccessToken();
}

export function getAccessToken() {
    return accessToken;
}