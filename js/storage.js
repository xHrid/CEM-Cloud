import { initAuth, requestLogin, getAccessToken } from './auth.js';
import { findOrCreateRootFolder, findFileByName, readDriveTextFile, updateDriveFile, uploadFile } from './drive_api.js';
import * as FS from './storage_adapter.js';

// =============================================================================
// MODULE STATE
// =============================================================================

let masterData = {
    currentProjectId: null,
    projects: [],
    metadata: { created_at: new Date().toISOString() }
};

let remoteMasterCache = null;

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Derives a safe, stable filesystem folder name for a project.
 * Format: SanitizedName_shortId  e.g. "My_Survey_a1b2c3"
 * NOTE: Once a project is created this value must never change, because all
 * stored file paths are derived from it. Renaming a project does NOT change
 * this folder name — it is anchored to the id.
 */
export function getProjectFolderName(project) {
    if (!project) return 'Unassigned';
    const safeName = project.name
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_|_$/g, '');
    const shortId = project.id.substring(0, 6);
    return `${safeName || 'Project'}_${shortId}`;
}

/**
 * Returns the currently active project object, falling back to the first
 * project if currentProjectId somehow points to a deleted project.
 */
function getActiveProject() {
    if (!masterData.projects || masterData.projects.length === 0) return null;
    return (
        masterData.projects.find(p => p.id === masterData.currentProjectId) ||
        masterData.projects[0]
    );
}

/** Persist masterData to the storage adapter (local FS or IndexedDB). */
async function _saveMasterData() {
    await FS.saveMasterData(masterData);
}

/**
 * Push the current masterData JSON to Google Drive.
 * Fire-and-forget — callers do NOT await this.
 */
async function pushMasterToDrive() {
    if (!getAccessToken()) return;
    try {
        const rootFolderId = await findOrCreateRootFolder();
        const driveFile = await findFileByName('master_data.json', rootFolderId);
        const blob = new Blob([JSON.stringify(masterData, null, 2)], { type: 'application/json' });
        if (driveFile) {
            await updateDriveFile(driveFile.id, blob);
            console.log('☁️ Auto-pushed Master JSON to Drive');
        } else {
            await uploadFile(blob, 'master_data.json', 'application/json', rootFolderId);
            console.log('☁️ Created Master JSON on Drive');
        }
    } catch (e) {
        console.error('Auto-push failed (offline?):', e);
    }
}

// =============================================================================
// BOOTSTRAP
// =============================================================================

/**
 * Loads masterData from local storage, migrating old (flat) schemas to the
 * project-based schema if needed. Creates a fresh default project on first run.
 */
async function ensureMasterJson() {
    const data = await FS.getMasterData();

    if (data) {
        // ── Migration: pre-project schema (v1 → v2) ──────────────────────────
        if (!data.projects) {
            console.log('Migrating flat data to project-based structure…');
            const defaultId = crypto.randomUUID();
            const defaultProject = {
                id: defaultId,
                name: 'Default Project',
                spots: data.spots || [],
                routes: data.routes || [],
                sites: data.sites || [],
                external_files: data.external_files || [],
                created_at: data.metadata?.created_at || new Date().toISOString()
            };
            masterData = {
                currentProjectId: defaultId,
                projects: [defaultProject],
                metadata: { ...data.metadata, schema_version: 2 }
            };
            await _saveMasterData();
        } else {
            masterData = data;
            // Guard: ensure currentProjectId is valid
            if (!masterData.projects.find(p => p.id === masterData.currentProjectId)) {
                masterData.currentProjectId = masterData.projects[0]?.id || null;
            }
        }
    } else {
        // ── Fresh install ─────────────────────────────────────────────────────
        const defaultId = crypto.randomUUID();
        masterData = {
            currentProjectId: defaultId,
            projects: [{
                id: defaultId,
                name: 'Untitled Project',
                spots: [],
                routes: [],
                sites: [],
                external_files: [],
                created_at: new Date().toISOString()
            }],
            metadata: { created_at: new Date().toISOString(), schema_version: 2 }
        };
        await _saveMasterData();
    }
}

// =============================================================================
// APP INIT (UI wiring)
// =============================================================================

export function initApp() {
    const authSection = document.getElementById('auth-section');
    if (!authSection) return;

    authSection.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:5px;">
            <button id="btn-select-storage" style="width:100%; background:#FF9800; color:white;">
                📂 Initialize Storage
            </button>
            <div id="folder-status" style="font-size:0.8rem; color:#666; text-align:center; display:none;"></div>
            <div id="drive-controls" style="display:none; flex-direction:column; gap:5px; margin-top:5px;">
                <button id="btn-login" style="width:100%; background:#4285F4; color:white;">Login to Drive</button>
                <button id="btn-sync-master" style="width:100%; background:#673AB7; color:white; display:none;">Check Remote Updates</button>
                <button id="btn-sync-manager" style="width:100%; background:#0F9D58; color:white; display:none;">Media Sync</button>
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

        // If storage is already initialised when we log in, kick off a sync check
        FS.getMasterData().then(data => {
            if (data) checkForRemoteUpdates(false);
        });
    });
}

function generateDataSignature(data) {
    if (!data || !data.projects) return "empty";
    
    return data.projects.map(p => {
        // Map each item to its ID + Timestamp, then sort to ensure order doesn't matter
        const spots = (p.spots || []).map(s => `${s.spotId}_${s.timestamp}`).sort().join(',');
        const sites = (p.sites || []).map(s => `${s.id}_${s.timestamp}`).sort().join(',');
        const routes = (p.routes || []).map(r => `${r.id}_${r.timestamp}`).sort().join(',');
        const files = (p.external_files || []).map(f => `${f.id}_${f.timestamp}`).sort().join(',');
        
        return `Project:${p.id}_${p.name}|Spots:${spots}|Sites:${sites}|Routes:${routes}|Files:${files}`;
    }).sort().join('||');
}

// Add this helper function to inject the script dynamically
async function ensureWatcherScript() {
    try {
        // 1. Check if the user already has the watcher in their local folder
        const exists = await FS.checkFileExists('watcher.py');
        
        if (!exists) {
            console.log('Fetching watcher.py from web server...');
            
            // 2. Fetch the script from your static site's root directory
            const response = await fetch('./watcher.py');
            
            if (!response.ok) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }
            
            // 3. Extract the text and convert it to a Blob
            const pythonCode = await response.text();
            const blob = new Blob([pythonCode], { type: 'text/plain' });
            
            // 4. Save it to the root of the user's selected local folder (empty array path)
            await FS.saveFile(blob, 'watcher.py', []); 
            console.log('✅ Successfully downloaded and injected watcher.py into local project root.');
        } else {
            console.log('watcher.py already exists locally. Skipping injection.');
        }
    } catch (e) {
        console.warn('Could not inject watcher.py (might be offline, missing from server, or in memory mode):', e);
    }
}

export async function selectAndInitStorage() {
    try {
        const storageInfo = await FS.initStorage();
        await ensureMasterJson();
        await ensureWatcherScript();

        const btn = document.getElementById('btn-select-storage');
        if (btn) btn.style.display = 'none';

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
            alert('Storage initialization failed.');
        }
    }
}

// =============================================================================
// DRIVE SYNC — MASTER JSON
// =============================================================================

export async function checkForRemoteUpdates(interactive = false) {
    if (!getAccessToken()) return;

    const btn = document.getElementById('btn-sync-master');
    if (interactive && btn) btn.textContent = 'Checking Drive…';

    try {
        const rootFolderId = await findOrCreateRootFolder();
        const driveFile = await findFileByName('master_data.json', rootFolderId);

        if (!driveFile) {
            if (interactive) alert('No Master File on Drive. Uploading local…');
            await pushMasterToDrive();
            if (interactive) alert('Done.');
            return;
        }

        const remoteText = await readDriveTextFile(driveFile.id);
        const remoteData = JSON.parse(remoteText);

        // [THE FIX] Compare deterministic data signatures instead of volatile JSON strings
        const localSignature = generateDataSignature(masterData);
        const remoteSignature = generateDataSignature(remoteData);

        if (localSignature === remoteSignature) {
            console.log('Sync: Clean. Data signatures match.');
            if (interactive) alert('✅ You are up to date.');
            return;
        }

        console.warn('Sync: Updates detected on Drive.');
        remoteMasterCache = { data: remoteData, fileId: driveFile.id };

        // Count spots across ALL projects for a useful conflict summary
        const localSpotCount = masterData.projects.reduce((n, p) => n + (p.spots?.length ?? 0), 0);
        const remoteSpotCount = remoteData.projects
            ? remoteData.projects.reduce((n, p) => n + (p.spots?.length ?? 0), 0)
            : (remoteData.spots?.length ?? 0); 

        document.dispatchEvent(new CustomEvent('master-sync-conflict', {
            detail: { localCount: localSpotCount, remoteCount: remoteSpotCount }
        }));

    } catch (e) {
        console.error('Sync Check Error:', e);
        if (interactive) alert('Check Failed: ' + e.message);
    } finally {
        if (interactive && btn) btn.textContent = 'Check Remote Updates';
    }
}

export async function resolveMasterConflict(action) {
    if (!remoteMasterCache) return;
    const { data: remoteData, fileId } = remoteMasterCache;

    try {
        if (action === 'pull') {
            masterData = remoteData;
            // If pulled data is old schema, migrate it in-memory
            if (!masterData.projects) {
                const id = crypto.randomUUID();
                masterData = {
                    currentProjectId: id,
                    projects: [{
                        id,
                        name: 'Default Project',
                        spots: masterData.spots || [],
                        routes: masterData.routes || [],
                        sites: masterData.sites || [],
                        external_files: masterData.external_files || [],
                        created_at: new Date().toISOString()
                    }],
                    metadata: { ...masterData.metadata, schema_version: 2 }
                };
            }
            await _saveMasterData();
            alert('Synced: Pulled from Drive.');

        } else if (action === 'push') {
            const blob = new Blob([JSON.stringify(masterData, null, 2)], { type: 'application/json' });
            await updateDriveFile(fileId, blob);
            alert('Synced: Pushed to Drive.');

        } else if (action === 'merge') {
            const merged = mergeDatasets(masterData, remoteData);
            masterData = merged;
            await _saveMasterData();
            const blob = new Blob([JSON.stringify(masterData, null, 2)], { type: 'application/json' });
            await updateDriveFile(fileId, blob);
            alert('Synced: Merged Local and Drive data.');
        }

        remoteMasterCache = null;
        window.dispatchEvent(new Event('data-updated'));
        window.dispatchEvent(new Event('project-changed'));

    } catch (e) {
        console.error('Resolution Error:', e);
        alert('Resolution Failed: ' + e.message);
    }
}

/**
 * Merges two masterData objects that both use the project-based schema.
 * Strategy:
 *  - Projects that exist in both are merged by timestamp-last-write-wins on items.
 *  - Projects that exist in only one side are kept as-is.
 *  - currentProjectId is kept from local.
 */
function mergeDatasets(local, remote) {
    // Normalise remote to project schema if it arrived as old flat schema
    const normaliseToProjects = (data) => {
        if (data.projects) return data;
        const id = crypto.randomUUID();
        return {
            currentProjectId: id,
            projects: [{
                id,
                name: 'Default Project',
                spots: data.spots || [],
                routes: data.routes || [],
                sites: data.sites || [],
                external_files: data.external_files || [],
                created_at: data.metadata?.created_at || new Date().toISOString()
            }],
            metadata: data.metadata || {}
        };
    };

    const l = normaliseToProjects(local);
    const r = normaliseToProjects(remote);

    // Merge individual item arrays by id, last-write-wins
    const mergeArray = (arr1 = [], arr2 = []) => {
        const map = new Map();
        [...arr1, ...arr2].forEach(item => {
            const id = item.spotId || item.id;
            if (!id) return;
            const existing = map.get(id);
            if (!existing) {
                map.set(id, item);
            } else {
                const existingTime = new Date(existing.timestamp || 0).getTime();
                const newTime = new Date(item.timestamp || 0).getTime();
                if (newTime > existingTime) map.set(id, item);
            }
        });
        return Array.from(map.values());
    };

    // Merge at project level
    const projectMap = new Map();

    l.projects.forEach(p => projectMap.set(p.id, { ...p }));

    r.projects.forEach(rp => {
        if (projectMap.has(rp.id)) {
            // Project exists on both sides — merge its contents
            const lp = projectMap.get(rp.id);
            projectMap.set(rp.id, {
                ...lp,
                spots: mergeArray(lp.spots, rp.spots),
                routes: mergeArray(lp.routes, rp.routes),
                sites: mergeArray(lp.sites, rp.sites),
                external_files: mergeArray(lp.external_files, rp.external_files)
            });
        } else {
            // Project only on remote — add it
            projectMap.set(rp.id, { ...rp });
        }
    });

    return {
        currentProjectId: l.currentProjectId,
        projects: Array.from(projectMap.values()),
        metadata: { ...l.metadata, last_merged: new Date().toISOString(), schema_version: 2 }
    };
}

// =============================================================================
// PUBLIC GETTERS
// =============================================================================

export function getSpots() {
    return getActiveProject()?.spots || [];
}
export function getRoutes() {
    return getActiveProject()?.routes || [];
}
export function getSites() {
    return getActiveProject()?.sites || [];
}
export function getExternalFiles() {
    return getActiveProject()?.external_files || [];
}
export function getLocalState() {
    return masterData;
}
export function getActiveProjectId() {
    return masterData.currentProjectId;
}

// =============================================================================
// SAVE FUNCTIONS
// =============================================================================

export async function saveSpot(spotData, imageBlob, audioBlob) {
    const project = getActiveProject();
    if (!project) throw new Error('No active project. Please initialise storage first.');

    const projectFolder = getProjectFolderName(project);
    const spotId = spotData.spotId || crypto.randomUUID();
    const safeSpotName = (spotData.name || `Spot_${spotId.substring(0, 8)}`)
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_|_$/g, '');

    const spotPathParts = [projectFolder, 'spots', safeSpotName];

    let imgPath = null;
    let audioPath = null;

    if (imageBlob) {
        imgPath = await FS.saveFile(imageBlob, `${safeSpotName}_cover.jpg`, [...spotPathParts, 'images']);
    }
    if (audioBlob) {
        audioPath = await FS.saveFile(audioBlob, `${safeSpotName}_note.webm`, [...spotPathParts, 'audio']);
    }

    const newSpot = {
        ...spotData,
        spotId,
        projectId: project.id,
        timestamp: new Date().toISOString(),
        image_local_filename: imgPath,
        audio_local_filename: audioPath
    };

    if (!project.spots) project.spots = [];
    project.spots.push(newSpot);

    await _saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    pushMasterToDrive();
    return newSpot;
}

export async function saveSite(siteName, kmlFile) {
    const project = getActiveProject();
    if (!project) throw new Error('No active project.');

    const projectFolder = getProjectFolderName(project);
    const kmlPath = await FS.saveFile(kmlFile, `${siteName}.kml`, [projectFolder, 'sites']);

    const newSite = {
        id: crypto.randomUUID(),
        projectId: project.id,
        name: siteName,
        kml_filename: kmlPath,
        timestamp: new Date().toISOString()
    };

    if (!project.sites) project.sites = [];
    project.sites.push(newSite);

    await _saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    pushMasterToDrive();
    return newSite;
}

export async function saveRoute(routeData) {
    const project = getActiveProject();
    if (!project) throw new Error('No active project.');

    const newRoute = {
        ...routeData,
        id: crypto.randomUUID(),
        projectId: project.id,
        timestamp: new Date().toISOString()
    };

    if (!project.routes) project.routes = [];
    project.routes.push(newRoute);

    await _saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    pushMasterToDrive();
    return newRoute;
}

export async function saveExternalFile(fileObj, spotIds) {
    const project = getActiveProject();
    if (!project) throw new Error('No active project.');

    const primarySpotId = spotIds[0];
    const spot = (project.spots || []).find(s => s.spotId === primarySpotId);

    const projectFolder = getProjectFolderName(project);
    const safeSpotName = (spot?.name || `Spot_${primarySpotId.substring(0, 8)}`)
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_|_$/g, '');

    const pathArray = [projectFolder, 'spots', safeSpotName, 'external_data'];
    const savedPath = await FS.saveFile(fileObj, fileObj.name, pathArray);

    const newFileEntry = {
        id: crypto.randomUUID(),
        name: fileObj.name,
        type: fileObj.type,
        linked_spots: spotIds,
        projectId: project.id,
        timestamp: new Date().toISOString(),
        sync_status: 'pending',
        local_path: savedPath
    };

    if (!project.external_files) project.external_files = [];
    project.external_files.push(newFileEntry);    // ← write to project, not root

    await _saveMasterData();
    window.dispatchEvent(new Event('data-updated'));
    pushMasterToDrive();
    return newFileEntry;
}

export async function getLocalFileUrl(relativePath) {
    return await FS.getFileUrl(relativePath);
}

// =============================================================================
// PROJECT MANAGEMENT
// =============================================================================

export async function createProject(name) {
    const newId = crypto.randomUUID();
    const newProject = {
        id: newId,
        name: name || 'Untitled Project',
        spots: [],
        routes: [],
        sites: [],
        external_files: [],
        created_at: new Date().toISOString()
    };
    masterData.projects.push(newProject);
    masterData.currentProjectId = newId;

    await _saveMasterData();
    window.dispatchEvent(new Event('project-changed'));
    pushMasterToDrive();
    return newProject;
}

export async function switchProject(projectId) {
    if (!masterData.projects.find(p => p.id === projectId)) {
        throw new Error('Project not found');
    }
    masterData.currentProjectId = projectId;
    await _saveMasterData();
    window.dispatchEvent(new Event('project-changed'));
    window.dispatchEvent(new Event('data-updated'));
}

export async function renameProject(projectId, newName) {
    const project = masterData.projects.find(p => p.id === projectId);
    if (!project) throw new Error('Project not found');
    if (!newName || !newName.trim()) throw new Error('Name cannot be empty');
    project.name = newName.trim();
    await _saveMasterData();
    // NOTE: getProjectFolderName uses the original name captured at creation
    // via the shortId anchor, so file paths are NOT affected by renaming.
    window.dispatchEvent(new Event('project-changed'));
    pushMasterToDrive();
}

export async function deleteProject(projectId) {
    if (masterData.projects.length <= 1) {
        throw new Error('Cannot delete the last remaining project.');
    }
    masterData.projects = masterData.projects.filter(p => p.id !== projectId);
    // If we deleted the active project, fall back to first
    if (masterData.currentProjectId === projectId) {
        masterData.currentProjectId = masterData.projects[0].id;
    }
    await _saveMasterData();
    window.dispatchEvent(new Event('project-changed'));
    window.dispatchEvent(new Event('data-updated'));
    pushMasterToDrive();
}

// =============================================================================
// ANALYSIS & SYSTEM (JOBS/HEARTBEAT)
// =============================================================================

export async function saveJobRequest(jobData) {
    const project = getActiveProject();
    if (!project) throw new Error("No active project.");

    const projectFolder = getProjectFolderName(project);
    const jobId = jobData.job_id || crypto.randomUUID();
    
    const queuePath = [projectFolder, 'jobs', 'queue'];
    const fileName = `${jobId}.json`;
    
    // [CHANGE] Include the user-defined name or fall back to the ID
    const finalData = {
        ...jobData,
        job_id: jobId,
        job_name: jobData.job_name || `Job ${jobId.substring(0,8)}`, // <-- NEW
        project_id: project.id,
        status: 'queued',
        created_at: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(finalData, null, 2)], { type: 'application/json' });
    await FS.saveFile(blob, fileName, queuePath);
    
    return finalData;
}

// [IN FILE: storage.js]

export async function getWatcherStatus() {
    // REMOVED: const project = getActiveProject();
    // REMOVED: const projectFolder = getProjectFolderName(project);
    
    // NEW: Always look at the root system folder
    const statusPath = 'system/status.json'; 

    try {
        const blob = await FS.getFileBlob(statusPath);
        if (!blob) return null;
        
        const text = await blob.text();
        return JSON.parse(text);
    } catch (e) {
        return null; 
    }
}

// [IN FILE: storage.js]

export async function getInstalledScripts() {
    // OLD CODE (Incorrectly looked inside active project):
    // const project = getActiveProject();
    // const projectFolder = getProjectFolderName(project);
    // const registryPath = `${projectFolder}/system/scripts/installed.json`;

    // NEW CODE (Correctly looks at Global Root):
    const registryPath = 'system/scripts/installed.json';

    try {
        const blob = await FS.getFileBlob(registryPath);
        if (!blob) {
            console.warn("Script registry not found at:", registryPath);
            return [];
        }
        const text = await blob.text();
        return JSON.parse(text);
    } catch (e) {
        console.error("Error loading scripts:", e);
        return [];
    }
}