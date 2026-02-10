import { getSpots, getSites, getLocalState } from './storage.js';
import { listAllDriveFiles, uploadFile, findOrCreateRootFolder, downloadBlob, ensureDrivePath } from './drive_api.js';
import * as FS from './storage_adapter.js';

export async function generateSyncReport() {
    const report = [];
    
    const driveFiles = await listAllDriveFiles();
    const driveMap = new Map(); 
    
    driveFiles.forEach(f => {
        if (f.appProperties && f.appProperties.relativePath) {
            driveMap.set(f.appProperties.relativePath, f);
        } else if (f.name === 'master_data.json') {
            driveMap.set('master_data.json', f);
        }
    });
    
    const expectedFiles = [];
    expectedFiles.push('master_data.json');

    getSpots().forEach(s => {
        if(s.image_local_filename) expectedFiles.push(s.image_local_filename);
        if(s.audio_local_filename) expectedFiles.push(s.audio_local_filename);
    });

    getSites().forEach(s => {
        if(s.kml_filename) expectedFiles.push(s.kml_filename);
    });

    const appState = getLocalState();
    if (appState.external_files) {
        appState.external_files.forEach(f => {
            if(f.local_path) expectedFiles.push(f.local_path);
        });
    }

    for (const relPath of expectedFiles) {
        const item = { name: relPath, isLocal: false, isDrive: false, driveId: null };

        if (await FS.checkFileExists(relPath)) {
            item.isLocal = true;
        }

        if (driveMap.has(relPath)) {
            item.isDrive = true;
            item.driveId = driveMap.get(relPath).id;
        }
        report.push(item);
    }
    return report;
}

export async function syncUp(relPath) {
    const rootFolderId = await findOrCreateRootFolder();

    const fileObj = await FS.getFileBlob(relPath); 
    if (!fileObj) throw new Error("Local file not found");

    if (relPath === 'master_data.json') {
         await uploadFile(fileObj, relPath, 'application/json', rootFolderId, relPath);
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