import { getSpots, getSites, getLocalState, getProjectFolderName } from './storage.js';
import { listAllDriveFiles, uploadFile, findOrCreateRootFolder, downloadBlob, ensureDrivePath } from './drive_api.js';
import * as FS from './storage_adapter.js';

export async function generateSyncReport(targetProjectId = null) {
    const report = [];
    const appState = getLocalState();
    
    // If no project specified, default to current
    const projectId = targetProjectId || appState.currentProjectId;
    const project = appState.projects.find(p => p.id === projectId);
    
    if (!project) return [];

    const projectFolder = getProjectFolderName(project);
    const driveFiles = await listAllDriveFiles(); // Still fetches all (optimization: filter by query)
    
    // Filter Drive files that belong to this project folder
    const driveMap = new Map(); 
    driveFiles.forEach(f => {
        if (f.appProperties && f.appProperties.relativePath) {
            // Check if file starts with project folder
            if (f.appProperties.relativePath.startsWith(projectFolder + '/')) {
                driveMap.set(f.appProperties.relativePath, f);
            }
        }
    });
    
    // Collect Expected Local Files for THIS project
    const expectedFiles = [];
    // We do NOT include master_data.json here in the project view, 
    // or we treat it as global. Let's keep it separate or handled by the "Global" indicator.
    
    if (project.spots) {
        project.spots.forEach(s => {
            if(s.image_local_filename) expectedFiles.push(s.image_local_filename);
            if(s.audio_local_filename) expectedFiles.push(s.audio_local_filename);
        });
    }
    if (project.sites) {
        project.sites.forEach(s => {
            if(s.kml_filename) expectedFiles.push(s.kml_filename);
        });
    }
    if (project.external_files) {
        project.external_files.forEach(f => {
            if(f.local_path) expectedFiles.push(f.local_path);
        });
    }

    // Build the report
    for (const relPath of expectedFiles) {
        const item = { name: relPath, isLocal: false, isDrive: false, driveId: null };
        if (await FS.checkFileExists(relPath)) item.isLocal = true;
        if (driveMap.has(relPath)) {
            item.isDrive = true;
            item.driveId = driveMap.get(relPath).id;
        }
        report.push(item);
    }
    
    // Check for "Drive Only" files (files on Drive but not in local JSON)
    // iterate driveMap keys...
    
    return report;
}

export async function getAllProjectsSyncStatus() {
    const appState = getLocalState();
    const statuses = {}; // { projectId: { synced: boolean, count: number } }
    
    const driveFiles = await listAllDriveFiles();
    const drivePaths = new Set(driveFiles.map(f => f.appProperties?.relativePath).filter(Boolean));

    for (const project of appState.projects) {
        let isSynced = true;
        const projectFolder = getProjectFolderName(project);
        
        // Quick check of known assets
        const assets = [];
        if(project.spots) project.spots.forEach(s => {
            if(s.image_local_filename) assets.push(s.image_local_filename);
            if(s.audio_local_filename) assets.push(s.audio_local_filename);
        });
        if(project.sites) project.sites.forEach(s => {
            if(s.kml_filename) assets.push(s.kml_filename);
        });

        for (const path of assets) {
            // It is synced if it exists on Drive
            // (Strictly: it should also exist Locally, but for "Sync Status" 
            // usually we care if it's safe on cloud)
            if (!drivePaths.has(path)) {
                isSynced = false;
                break;
            }
        }
        
        statuses[project.id] = isSynced;
    }
    
    return statuses;
}

export async function syncUp(relPath) {
    const rootFolderId = await findOrCreateRootFolder();
    const fileObj = await FS.getFileBlob(relPath);
    if (!fileObj) throw new Error("Local file not found");

    if (relPath === 'master_data.json') {
        // Check if it already exists — update rather than create a duplicate
        const existing = await findFileByName('master_data.json', rootFolderId);
        if (existing) {
            await updateDriveFile(existing.id, fileObj);
        } else {
            await uploadFile(fileObj, relPath, 'application/json', rootFolderId, relPath);
        }
    } else {
        const parts = relPath.split('/');
        const filename = parts.pop();
        const parentId = await ensureDrivePath(parts, rootFolderId);
        await uploadFile(fileObj, filename, fileObj.type || 'application/octet-stream', parentId, relPath);
    }
}

export async function syncDown(driveId, relPath) {
    const blob = await downloadBlob(driveId);
    
    if (relPath === 'master_data.json') {
        const text = await blob.text();
        const data = JSON.parse(text);
        await FS.saveMasterData(data);
    } else {
        const parts = relPath.split('/');
        const filename = parts.pop();
        
        await FS.saveFile(blob, filename, parts);
    }
}

export async function syncBatch(items, direction, onProgress) {
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
            if (direction === 'push') {
                await syncUp(item.name);
            } else if (direction === 'pull') {
                if (!item.driveId) throw new Error("Missing Drive ID");
                await syncDown(item.driveId, item.name);
            }
            successCount++;
        } catch (e) {
            console.error(`Failed to ${direction} ${item.name}:`, e);
            failCount++;
        }
        
        if (onProgress) {
            const percent = Math.round(((i + 1) / items.length) * 100);
            onProgress(percent, item.name, failCount);
        }
    }
    return { success: successCount, failed: failCount };
}