const HAS_NATIVE_FS = 'showDirectoryPicker' in window;

const DB_NAME = 'CEM_Toolkit_DB';
const DB_STORE = 'files';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            e.target.result.createObjectStore(DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbSave(key, blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(blob, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}


let rootHandle = null; 
let memoryMode = false; 

export async function initStorage() {
    if (HAS_NATIVE_FS) {
        try {
            rootHandle = await window.showDirectoryPicker();
            memoryMode = false;
            return { type: 'native', handle: rootHandle, name: rootHandle.name };
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.warn("Native FS failed, falling back to IDB", e);
        }
    }
    
    memoryMode = true;
    console.log("Storage: Using IndexedDB (Virtual FS)");
    return { type: 'idb', name: 'Browser Storage' };
}

export async function getMasterData() {
    if (!memoryMode && rootHandle) {
        try {
            const fh = await rootHandle.getFileHandle('master_data.json');
            const file = await fh.getFile();
            return JSON.parse(await file.text());
        } catch (e) { return null; }
    } else {
        const blob = await idbGet('master_data.json');
        if (!blob) return null;
        return JSON.parse(await blob.text());
    }
}

export async function saveMasterData(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    
    if (!memoryMode && rootHandle) {
        const fh = await rootHandle.getFileHandle('master_data.json', { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
    } else {
        await idbSave('master_data.json', blob);
    }
}

export async function saveFile(blob, filename, pathParts) {
    const fullPath = [...pathParts, filename].join('/');

    if (!memoryMode && rootHandle) {
        let currentDir = rootHandle;
        for (const folder of pathParts) {
            currentDir = await currentDir.getDirectoryHandle(folder, { create: true });
        }
        const fh = await currentDir.getFileHandle(filename, { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
        return fullPath; 
    } else {
        await idbSave(fullPath, blob);
        return fullPath;
    }
}

export async function getFileUrl(relativePath) {
    if (!relativePath) return null;

    if (!memoryMode && rootHandle) {
        try {
            const parts = relativePath.split('/');
            const filename = parts.pop();
            let currentDir = rootHandle;
            for (const folder of parts) {
                currentDir = await currentDir.getDirectoryHandle(folder);
            }
            const fh = await currentDir.getFileHandle(filename);
            const file = await fh.getFile();
            return URL.createObjectURL(file);
        } catch (e) {
            console.warn("Missing file (native):", relativePath);
            return null;
        }
    } else {
        try {
            const blob = await idbGet(relativePath);
            if (blob) return URL.createObjectURL(blob);
            return null;
        } catch (e) {
            return null;
        }
    }
}

export async function getFileBlob(relativePath) {
    if (!relativePath) return null;
    if (!memoryMode && rootHandle) {
        try {
            const parts = relativePath.split('/');
            const filename = parts.pop();
            let currentDir = rootHandle;
            for (const folder of parts) {
                currentDir = await currentDir.getDirectoryHandle(folder);
            }
            const fh = await currentDir.getFileHandle(filename);
            return await fh.getFile();
        } catch (e) { return null; }
    } else {
        return await idbGet(relativePath);
    }
}

export async function checkFileExists(relativePath) {
    if (!memoryMode && rootHandle) {
        try {
            const parts = relativePath.split('/');
            const filename = parts.pop();
            let currentDir = rootHandle;
            for (const folder of parts) {
                currentDir = await currentDir.getDirectoryHandle(folder);
            }
            await currentDir.getFileHandle(filename);
            return true;
        } catch (e) { return false; }
    } else {
        const blob = await idbGet(relativePath);
        return !!blob;
    }
}