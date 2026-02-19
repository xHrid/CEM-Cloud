// [FILE: js/media_sync.js]
import { getLocalState, getProjectFolderName } from './storage.js';
import { listAllDriveFiles, uploadFile, findOrCreateRootFolder, downloadBlob, ensureDrivePath, findFileByName, updateDriveFile } from './drive_api.js';
import * as FS from './storage_adapter.js';

let isSyncing = false; // Prevents overlapping batch runs

export async function generateSyncReport(targetProjectId = null) {
    const report = [];
    const appState = getLocalState();
    
    const projectId = targetProjectId || appState.currentProjectId;
    const project = appState.projects.find(p => p.id === projectId);
    
    if (!project) return [];

    const projectFolder = getProjectFolderName(project);
    const driveFiles = await listAllDriveFiles(); 
    
    const driveMap = new Map(); 
    driveFiles.forEach(f => {
        if (f.appProperties?.relativePath?.startsWith(projectFolder + '/')) {
            driveMap.set(f.appProperties.relativePath, f);
        }
    });
    
    const expectedFiles = [];
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

    const processedPaths = new Set();

    // 1. Process Expected Local Files
    for (const relPath of expectedFiles) {
        processedPaths.add(relPath);
        const item = { name: relPath, isLocal: false, isDrive: false, driveId: null };
        if (await FS.checkFileExists(relPath)) item.isLocal = true;
        
        if (driveMap.has(relPath)) {
            item.isDrive = true;
            item.driveId = driveMap.get(relPath).id;
        }
        report.push(item);
    }
    
    // 2. Process "Drive Only" Files (Files on cloud but not tracked locally)
    for (const [relPath, driveFile] of driveMap.entries()) {
        if (!processedPaths.has(relPath)) {
            report.push({
                name: relPath,
                isLocal: false,
                isDrive: true,
                driveId: driveFile.id
            });
        }
    }
    
    return report;
}

export async function getAllProjectsSyncStatus() {
    const appState = getLocalState();
    const statuses = {}; 
    
    const driveFiles = await listAllDriveFiles();
    const drivePaths = new Set(driveFiles.map(f => f.appProperties?.relativePath).filter(Boolean));

    for (const project of appState.projects) {
        let isSynced = true;
        const projectFolder = getProjectFolderName(project);
        
        const expectedFiles = [];
        if(project.spots) project.spots.forEach(s => {
            if(s.image_local_filename) expectedFiles.push(s.image_local_filename);
            if(s.audio_local_filename) expectedFiles.push(s.audio_local_filename);
        });
        if(project.sites) project.sites.forEach(s => {
            if(s.kml_filename) expectedFiles.push(s.kml_filename);
        });
        if(project.external_files) project.external_files.forEach(f => {
            if(f.local_path) expectedFiles.push(f.local_path);
        });

        // Strict 2-Way Check: Every tracked file MUST exist physically on disk AND on Drive
        for (const path of expectedFiles) {
            const hasDrive = drivePaths.has(path);
            const hasLocal = await FS.checkFileExists(path); 
            
            if (!hasDrive || !hasLocal) {
                isSynced = false;
                break;
            }
        }
        
        // Strict 2-Way Check: No Drive files should be missing from the local machine
        if (isSynced) {
            for (const drivePath of drivePaths) {
                if (drivePath.startsWith(projectFolder + '/') && !expectedFiles.includes(drivePath)) {
                    isSynced = false;
                    break;
                }
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
        const existing = await findFileByName('master_data.json', rootFolderId);
        if (existing) await updateDriveFile(existing.id, fileObj);
        else await uploadFile(fileObj, relPath, 'application/json', rootFolderId, relPath);
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

export async function syncBatch(items, direction) {
    if (isSyncing) throw new Error("A sync operation is already running in the background.");
    isSyncing = true;
    
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
            if (direction === 'push') await syncUp(item.name);
            else if (direction === 'pull') {
                if (!item.driveId) throw new Error("Missing Drive ID");
                await syncDown(item.driveId, item.name);
            }
            successCount++;
        } catch (e) {
            console.error(`Failed to ${direction} ${item.name}:`, e);
            failCount++;
        }
        
        // Dispatch event instead of manipulating DOM directly
        const percent = Math.round(((i + 1) / items.length) * 100);
        window.dispatchEvent(new CustomEvent('sync-progress', { 
            detail: { percent, currentFile: item.name, fails: failCount } 
        }));
    }

    isSyncing = false;
    window.dispatchEvent(new CustomEvent('sync-batch-complete', { 
        detail: { success: successCount, failed: failCount, direction } 
    }));
    
    return { success: successCount, failed: failCount };
}