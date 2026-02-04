import { getRootHandle, getSpots, getSites, getLocalState } from './storage.js';
import { listAllDriveFiles, uploadFile, findOrCreateRootFolder, downloadBlob, ensureDrivePath } from './drive_api.js';

export async function generateSyncReport() {
    const report = [];
    const rootHandle = getRootHandle();
    if (!rootHandle) return [];

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
        const item = {
            name: relPath, 
            isLocal: false,
            isDrive: false,
            driveId: null
        };

        try {
            await checkLocalFileExists(rootHandle, relPath);
            item.isLocal = true;
        } catch (e) {
            item.isLocal = false;
        }

        if (driveMap.has(relPath)) {
            item.isDrive = true;
            item.driveId = driveMap.get(relPath).id;
        }

        report.push(item);
    }
    return report;
}

async function checkLocalFileExists(rootHandle, relPath) {
    if (relPath === 'master_data.json') {
        await rootHandle.getFileHandle(relPath);
        return;
    }
    const parts = relPath.split('/');
    const filename = parts.pop();
    let currentDir = rootHandle;
    for (const folder of parts) {
        currentDir = await currentDir.getDirectoryHandle(folder);
    }
    await currentDir.getFileHandle(filename);
}

export async function syncUp(relPath) {
    const rootHandle = getRootHandle();
    const rootFolderId = await findOrCreateRootFolder();

    let fileObj;
    if (relPath === 'master_data.json') {
        const fh = await rootHandle.getFileHandle(relPath);
        fileObj = await fh.getFile();
        await uploadFile(fileObj, relPath, 'application/json', rootFolderId, relPath);
    } else {
        const parts = relPath.split('/');
        const filename = parts.pop();
        
        let currentDir = rootHandle;
        for (const folder of parts) {
            currentDir = await currentDir.getDirectoryHandle(folder);
        }
        const fh = await currentDir.getFileHandle(filename);
        fileObj = await fh.getFile();

        const parentId = await ensureDrivePath(parts, rootFolderId);
        await uploadFile(fileObj, filename, fileObj.type, parentId, relPath);
    }
}

export async function syncDown(driveId, relPath) {
    const rootHandle = getRootHandle();
    const blob = await downloadBlob(driveId);
    
    if (relPath === 'master_data.json') {
        const fh = await rootHandle.getFileHandle(relPath, { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
    } else {
        const parts = relPath.split('/');
        const filename = parts.pop();
        
        let currentDir = rootHandle;
        for (const folder of parts) {
            currentDir = await currentDir.getDirectoryHandle(folder, { create: true });
        }
        
        const fh = await currentDir.getFileHandle(filename, { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
    }
}