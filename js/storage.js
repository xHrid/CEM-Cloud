import { initAuth, requestLogin, getAccessToken } from './auth.js';
import { findOrCreateRootFolder, findFileByName, readDriveTextFile, updateDriveFile, uploadFile } from './drive_api.js';
import * as FS from './storage_adapter.js'; 

let masterData = {
    spots: [],
    routes: [],
    sites: [],
    external_files: [],
    metadata: { created_at: new Date().toISOString() }
};

const MASTER_FILENAME = 'master_data.json';

export function initApp() {
    const authSection = document.getElementById('auth-section');
    if (authSection) {
        authSection.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:5px;">
                <button id="btn-select-storage" style="width:100%; background:#FF9800; color:white;">
                    📂 Initialize Storage
                </button>
                <div id="folder-status" style="font-size:0.8rem; color:#666; text-align:center; display:none;">No folder selected</div>
                
                <div id="drive-controls" style="display:none; gap:5px; margin-top:5px;">
                    <button id="btn-login" style="width:100%; background:#4285F4; color:white; flex:1;">Login to Drive</button>
                    <button id="btn-sync-master" style="width:100%; background:#673AB7; color:white; flex:1; display:none;">Check Remote Updates</button>
                    <button id="btn-sync-manager" style="width:100%; background:#0F9D58; color:white; flex:1; display:none;">Media Sync</button>
                </div>
            </div>
        `;
        
        document.getElementById('btn-select-storage').onclick = selectAndInitStorage;
        document.getElementById('btn-login').onclick = requestLogin;
        
        document.getElementById('btn-sync-master').onclick = () => checkForRemoteUpdates(true);

        initAuth(() => {
            document.getElementById('btn-login').style.display = 'none';
            document.getElementById('btn-sync-manager').style.display = 'block';
            document.getElementById('btn-sync-master').style.display = 'block';
            
            FS.getMasterData().then(data => {
                if(data) checkForRemoteUpdates(false);
            });
        });
    }
}

export async function selectAndInitStorage() {
    try {
        const storageInfo = await FS.initStorage();
        
        await ensureMasterJson();
        
        const btn = document.getElementById('btn-select-storage');
        if(btn) btn.style.display = 'none';
        
        const status = document.getElementById('folder-status');
        status.textContent = storageInfo.type === 'native' 
            ? `📂 Local Folder: ${storageInfo.name}` 
            : `💾 Browser Storage (IndexedDB)`;
        status.style.display = 'block';
        
        document.getElementById('drive-controls').style.display = 'flex';
        
        window.dispatchEvent(new Event('storage-ready'));
        window.dispatchEvent(new Event('data-updated'));
        
        if (getAccessToken()) checkForRemoteUpdates(false);

    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error(error);
            alert("Storage initialization failed.");
        }
    }
}

let remoteMasterCache = null; 

async function pushMasterToDrive() {
    if (!getAccessToken()) return; 

    try {
        const rootFolderId = await findOrCreateRootFolder();
        const driveFile = await findFileByName('master_data.json', rootFolderId);
        
        const blob = new Blob([JSON.stringify(masterData, null, 2)], { type: 'application/json' });

        if (driveFile) {
            await updateDriveFile(driveFile.id, blob);
            console.log("☁️ Auto-pushed Master JSON to Drive");
        } else {
            await uploadFile(blob, 'master_data.json', 'application/json', rootFolderId);
            console.log("☁️ Created Master JSON on Drive");
        }
    } catch (e) {
        console.error("Auto-push failed (offline?):", e);
    }
}

export async function checkForRemoteUpdates(interactive = false) {
    if (!getAccessToken()) return; // [FIX] Removed !rootHandle check

    if(interactive) {
        const btn = document.getElementById('btn-sync-master');
        if(btn) btn.textContent = "Checking Drive...";
    }

    try {
        const rootFolderId = await findOrCreateRootFolder();
        const driveFile = await findFileByName('master_data.json', rootFolderId);

        if (!driveFile) {
            if(interactive) alert("No Master File on Drive. Uploading local...");
            await pushMasterToDrive();
            if(interactive) alert("Done.");
            return;
        }

        const remoteText = await readDriveTextFile(driveFile.id);
        const remoteData = JSON.parse(remoteText);
        
        const localStr = JSON.stringify(masterData);
        const remoteStr = JSON.stringify(remoteData);

        if (localStr === remoteStr) {
            console.log("Sync: Clean.");
            if(interactive) alert("✅ You are up to date.");
            return;
        }

        console.warn("Sync: Updates detected on Drive.");
        remoteMasterCache = { data: remoteData, fileId: driveFile.id };
        
        document.dispatchEvent(new CustomEvent('master-sync-conflict', { 
            detail: { 
                localCount: masterData.spots.length, 
                remoteCount: remoteData.spots.length 
            }
        }));

    } catch (e) {
        console.error("Sync Check Error:", e);
        if(interactive) alert("Check Failed: " + e.message);
    } finally {
        if(interactive) {
            const btn = document.getElementById('btn-sync-master');
            if(btn) btn.textContent = "Check Remote Updates";
        }
    }
}

export async function resolveMasterConflict(action) {
    if (!remoteMasterCache) return;
    const { data: remoteData, fileId } = remoteMasterCache;
    
    try {
        if (action === 'pull') {
            masterData = remoteData;
            await saveMasterData(); 
            alert("Synced: Pulled from Drive.");
        } 
        else if (action === 'push') {
            const blob = new Blob([JSON.stringify(masterData, null, 2)], { type: 'application/json' });
            await updateDriveFile(fileId, blob);
            alert("Synced: Pushed to Drive.");
        } 
        else if (action === 'merge') {
            const merged = mergeDatasets(masterData, remoteData);
            masterData = merged;
            
            await saveMasterData(); 
            const blob = new Blob([JSON.stringify(masterData, null, 2)], { type: 'application/json' });
            await updateDriveFile(fileId, blob);
            alert("Synced: Merged Local and Drive data.");
        }
        
        remoteMasterCache = null;
        window.dispatchEvent(new Event('data-updated'));
        
    } catch (e) {
        console.error("Resolution Error:", e);
        alert("Resolution Failed: " + e.message);
    }
}

function mergeDatasets(local, remote) {
    const mergeArray = (arr1, arr2) => {
        const map = new Map();
        [...arr1, ...arr2].forEach(item => {
            const id = item.spotId || item.id; 
            if (!id) return;
            if (map.has(id)) {
                const existing = map.get(id);
                const existingTime = new Date(existing.timestamp || 0).getTime();
                const newItemTime = new Date(item.timestamp || 0).getTime();
                if (newItemTime > existingTime) map.set(id, item);
            } else {
                map.set(id, item);
            }
        });
        return Array.from(map.values());
    };

    return {
        ...local,
        spots: mergeArray(local.spots || [], remote.spots || []),
        routes: mergeArray(local.routes || [], remote.routes || []),
        sites: mergeArray(local.sites || [], remote.sites || []),
        external_files: mergeArray(local.external_files || [], remote.external_files || []),
        metadata: { ...local.metadata, last_merged: new Date().toISOString() }
    };
}


async function ensureMasterJson() {
    const data = await FS.getMasterData();
    if (data) {
        masterData = data;
        if(!masterData.spots) masterData.spots = [];
        if(!masterData.external_files) masterData.external_files = [];
        if(!masterData.sites) masterData.sites = [];
    } else {
        masterData = { 
            spots: [], routes: [], sites: [], external_files: [], 
            metadata: { created_at: new Date().toISOString() } 
        };
        await FS.saveMasterData(masterData);
    }
}

async function saveMasterData() {
    await FS.saveMasterData(masterData);
}

export function getSpots() { return masterData.spots || []; }
export function getRoutes() { return masterData.routes || []; }
export function getSites() { return masterData.sites || []; }
export function getLocalState() { return masterData; }

// --- Save Functions (Now using Adapter exclusively) ---

export async function saveSpot(spotData, imageBlob, audioBlob) {
    const spotId = spotData.spotId || crypto.randomUUID();
    const sanitizeFilename = (n) => n.replace(/[^a-z0-9]/gi, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
    const safeName = spotData.name ? sanitizeFilename(spotData.name) : `Spot_${spotId.substring(0,8)}`;
    const spotFolderPath = ['spots', safeName]; 

    let imgPath = null;
    let audioPath = null;

    if (imageBlob) {
        imgPath = await FS.saveFile(imageBlob, `${safeName}_cover.jpg`, [...spotFolderPath, 'images']);
    }

    if (audioBlob) {
        audioPath = await FS.saveFile(audioBlob, `${safeName}_note.webm`, [...spotFolderPath, 'audio']);
    }

    const newSpot = {
        ...spotData,
        spotId: spotId,
        timestamp: new Date().toISOString(),
        image_local_filename: imgPath,
        audio_local_filename: audioPath
    };

    masterData.spots.push(newSpot);
    await saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    pushMasterToDrive(); 
    return newSpot;
}

export async function saveSite(siteName, kmlFile) {
    const kmlPath = await FS.saveFile(kmlFile, `${siteName}.kml`, ['sites']);
    const newSite = { id: crypto.randomUUID(), name: siteName, kml_filename: kmlPath, timestamp: new Date().toISOString() };
    masterData.sites.push(newSite);
    await saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    pushMasterToDrive();
    return newSite;
}

export async function saveExternalFile(fileObj, spotIds) {
    const primarySpotId = spotIds[0];
    const spot = masterData.spots.find(s => s.spotId === primarySpotId);
    const sanitizeFilename = (n) => n.replace(/[^a-z0-9]/gi, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
    const safeName = spot && spot.name ? sanitizeFilename(spot.name) : `Spot_${primarySpotId.substring(0,8)}`;
    const pathArray = ['spots', safeName, 'external_data'];
    
    const savedPath = await FS.saveFile(fileObj, fileObj.name, pathArray);

    const newFileEntry = {
        id: crypto.randomUUID(),
        name: fileObj.name,
        type: fileObj.type,
        linked_spots: spotIds,
        timestamp: new Date().toISOString(),
        sync_status: 'pending',
        local_path: savedPath 
    };

    if (!masterData.external_files) masterData.external_files = [];
    masterData.external_files.push(newFileEntry);
    await saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    pushMasterToDrive();
    return newFileEntry;
}

export async function saveRoute(routeData) {
    const newRoute = { ...routeData, id: crypto.randomUUID(), timestamp: new Date().toISOString() };
    masterData.routes.push(newRoute);
    await saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    pushMasterToDrive();
    return newRoute;
}

export async function getLocalFileUrl(relativePath) {
    return await FS.getFileUrl(relativePath);
}