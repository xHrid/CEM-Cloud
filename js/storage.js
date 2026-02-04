import { initAuth, requestLogin } from './auth.js';

let rootHandle = null; 
let masterData = {
    spots: [],
    routes: [],
    sites: [],
    external_files: [],
    metadata: { created_at: new Date().toISOString() }
};

const PROJECT_ROOT_NAME = "Ecological_Monitoring_Data";

export function initApp() {
    const authSection = document.getElementById('auth-section');
    if (authSection) {
        authSection.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:5px;">
                <button id="btn-select-folder" style=" width:100%; background:#FF9800; color:white;">📂 Select Local Folder</button>
                <div id="folder-status" style="font-size:0.8rem; color:#666; text-align:center; display:none;">No folder selected</div>
                
                <div id="drive-controls" style="display:none; gap:5px; margin-top:5px;">
                    <button id="btn-login" style=" width:100%; background:#4285F4; color:white; flex:1;">Login</button>
                    <button id="btn-sync-manager" style=" width:100%; background:#0F9D58; color:white; flex:1; display:none;">Sync Manager</button>
                </div>
            </div>
        `;
        document.getElementById('btn-select-folder').onclick = selectAndInitFolder;
        document.getElementById('btn-login').onclick = requestLogin;
        initAuth(() => {
            document.getElementById('btn-login').style.display = 'none';
            document.getElementById('btn-sync-manager').style.display = 'block';
        });
    }
}

export async function selectAndInitFolder() {
    try {
        const handle = await window.showDirectoryPicker();
        rootHandle = await handle.getDirectoryHandle(PROJECT_ROOT_NAME, { create: true });
        
        await rootHandle.getDirectoryHandle('spots', { create: true });
        await rootHandle.getDirectoryHandle('sites', { create: true });
        
        await ensureMasterJson();
        
        document.getElementById('btn-select-folder').style.display = 'none';
        document.getElementById('folder-status').textContent = `📂 ${handle.name}/${PROJECT_ROOT_NAME}`;
        document.getElementById('folder-status').style.display = 'block';
        document.getElementById('drive-controls').style.display = 'flex';
        
        window.dispatchEvent(new Event('storage-ready'));
        window.dispatchEvent(new Event('data-updated'));
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error(error);
            alert("Folder access failed.");
        }
    }
}

async function ensureMasterJson() {
    try {
        const fileHandle = await rootHandle.getFileHandle('master_data.json');
        const file = await fileHandle.getFile();
        masterData = JSON.parse(await file.text());
        if(!masterData.spots) masterData.spots = [];
        if(!masterData.external_files) masterData.external_files = [];
        if(!masterData.sites) masterData.sites = [];
    } catch (e) {
        await saveMasterData();
    }
}

async function saveMasterData() {
    if (!rootHandle) return;
    const fileHandle = await rootHandle.getFileHandle('master_data.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(masterData, null, 2));
    await writable.close();
}

async function saveFileToPath(blob, filename, pathArray) {
    if (!rootHandle) throw new Error("No folder selected");
    
    let currentDir = rootHandle;
    for (const folder of pathArray) {
        currentDir = await currentDir.getDirectoryHandle(folder, { create: true });
    }
    
    const fileHandle = await currentDir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    
    return [...pathArray, filename].join('/'); 
}

export function getSpots() { return masterData.spots; }
export function getRoutes() { return masterData.routes; }
export function getSites() { return masterData.sites; }
export function getLocalState() { return masterData; }
export function getRootHandle() { return rootHandle; }


export async function saveSpot(spotData, imageBlob, audioBlob) {
    const spotId = spotData.spotId || crypto.randomUUID();
    let imgPath = null;
    let audioPath = null;

    if (imageBlob) {
        imgPath = await saveFileToPath(imageBlob, `cover.jpg`, ['spots', spotId, 'images']);
    }

    if (audioBlob) {
        audioPath = await saveFileToPath(audioBlob, `note.webm`, ['spots', spotId, 'audio']);
    }

    const newSpot = {
        ...spotData,
        spotId: spotId,
        timestamp: new Date().toISOString(),
        image_local_filename: imgPath, // Now storing relative path
        audio_local_filename: audioPath
    };

    masterData.spots.push(newSpot);
    await saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    return newSpot;
}

export async function saveSite(siteName, kmlFile) {
    const kmlPath = await saveFileToPath(kmlFile, `${siteName}.kml`, ['sites']);
    
    const newSite = { 
        id: crypto.randomUUID(), 
        name: siteName, 
        kml_filename: kmlPath 
    };
    masterData.sites.push(newSite);
    await saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    return newSite;
}

export async function saveExternalFile(fileObj, spotIds) {
    const primarySpotId = spotIds[0];
    const pathArray = ['spots', primarySpotId, 'external_data'];
    
    const savedPath = await saveFileToPath(fileObj, fileObj.name, pathArray);

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
    return newFileEntry;
}

export async function getLocalFileUrl(relativePath) {
    if (!rootHandle || !relativePath) return null;
    try {
        const parts = relativePath.split('/');
        const filename = parts.pop();
        
        let currentDir = rootHandle;
        for (const folder of parts) {
            currentDir = await currentDir.getDirectoryHandle(folder);
        }
        
        const fileHandle = await currentDir.getFileHandle(filename);
        const file = await fileHandle.getFile();
        return URL.createObjectURL(file);
    } catch (e) {
        console.warn("Missing file:", relativePath);
        return null;
    }
}

export async function saveRoute(routeData) {
    const newRoute = { ...routeData, id: crypto.randomUUID(), timestamp: new Date().toISOString() };
    masterData.routes.push(newRoute);
    await saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    return newRoute;
}