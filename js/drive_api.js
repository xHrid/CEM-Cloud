import { getAccessToken } from './auth.js';
import { CONFIG } from './config.js';

const ROOT_FOLDER_NAME = CONFIG.DRIVE_ROOT_FOLDER;


async function fetchDrive(url, options = {}) {
    const token = getAccessToken();
    if (!token) throw new Error("Not logged in");
    const headers = { ...options.headers, 'Authorization': `Bearer ${token}` };
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) throw new Error(`Drive API Error: ${res.statusText}`);
    return res;
}

export async function findOrCreateRootFolder() {
    const q = `name = '${ROOT_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const res = await fetchDrive(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.files && data.files.length > 0) return data.files[0].id;

    const createRes = await fetchDrive('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ROOT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
    });
    return (await createRes.json()).id;
}

export async function findFileByName(filename, parentId) {
    const q = `name = '${filename}' and '${parentId}' in parents and trashed = false`;
    const res = await fetchDrive(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id, name, modifiedTime)`);
    const data = await res.json();
    return data.files && data.files.length > 0 ? data.files[0] : null;
}

export async function readDriveTextFile(fileId) {
    const res = await fetchDrive(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return await res.text();
}

export async function updateDriveFile(fileId, blob) {
    const res = await fetchDrive(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        body: blob
    });
    return await res.json();
}

const folderCache = new Map();

function escapeQueryString(str) {
    return str.replace(/'/g, "\\'");
}

export async function ensureDrivePath(pathParts, rootId) {
    let currentParentId = rootId;

    for (const folderName of pathParts) {
        const cacheKey = `${currentParentId}|${folderName}`;

        if (folderCache.has(cacheKey)) {
            currentParentId = await folderCache.get(cacheKey);
            continue;
        }

        const resolveFolderId = async () => {
            const safeName = escapeQueryString(folderName);
            const q = `name = '${safeName}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
            
            const res = await fetchDrive(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`);
            const data = await res.json();

            if (data.files && data.files.length > 0) {
                return data.files[0].id;
            } else {
                const createRes = await fetchDrive('https://www.googleapis.com/drive/v3/files', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: folderName,
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [currentParentId]
                    })
                });
                const folder = await createRes.json();
                return folder.id;
            }
        };

        const folderPromise = resolveFolderId();
        folderCache.set(cacheKey, folderPromise);

        try {
            currentParentId = await folderPromise;
        } catch (e) {
            folderCache.delete(cacheKey);
            throw e;
        }
    }
    return currentParentId;
}

export async function listAllDriveFiles() {
    const q = "trashed = false"; 
    const res = await fetchDrive(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id, name, mimeType, parents, appProperties)`);
    const data = await res.json();
    return data.files || [];
}

export async function downloadBlob(fileId) {
    const res = await fetchDrive(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return await res.blob();
}

export async function uploadFile(blob, filename, mimeType, parentId, relativePath = null) {
    const metadata = { name: filename, mimeType: mimeType, parents: [parentId] };
    if (relativePath) metadata.appProperties = { relativePath: relativePath };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const res = await fetchDrive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        body: form
    });
    return await res.json();
}