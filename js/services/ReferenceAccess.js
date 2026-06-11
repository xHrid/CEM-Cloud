/**
 * ReferenceAccess.js — read bytes for reference-imported files in server mode.
 *
 * Why this exists
 * ---------------
 * Media can be imported two ways (ProjectUI / Repository):
 *   • copy      (saveExternalFile)            — bytes copied into the app's
 *                                               storage root; readable by
 *                                               StorageAdapter.getFileBlob().
 *   • reference (saveExternalFileByReference) — NO bytes copied; only a disk
 *                                               path string is stored.
 *
 * Reference imports were built for the LOCAL watcher, which runs on the machine
 * and reads that path straight off disk. In SERVER ("ship to cluster") mode the
 * cluster cannot see the user's disk, so the file's BYTES must be uploaded — but
 * the browser kept none, and a sandboxed page cannot read an arbitrary absolute
 * path. getFileBlob() therefore returns null → "Could not read reference file".
 *
 * Fix: the user grants the folder that holds the referenced audio ONCE per
 * session via the File System Access API. The directory handle is persisted in
 * IndexedDB (StorageAdapter.savePersistentHandle) and reused for every job and
 * every previously-imported reference. Files are matched by BASENAME, so the
 * stored path's format (Windows vs WSL vs posix) is irrelevant and old imports
 * keep working. Bytes are read on demand — nothing is copied or duplicated.
 *
 * Browser support: File System Access (Chromium desktop). On unsupported
 * browsers reference upload is unavailable in server mode; copies still work.
 */

import * as StorageAdapter from '../data/StorageAdapter.js';

const HANDLE_KEY = 'reference_root_dir';
const HAS_FS = typeof globalThis !== 'undefined' && 'showDirectoryPicker' in globalThis;

/** @type {FileSystemDirectoryHandle|null} */
let _dirHandle = null;
/** @type {Promise<Map<string, FileSystemFileHandle>>|null} */
let _indexPromise = null;

/** Last path segment, normalised + lowercased, format-agnostic. */
function _basename(p) {
    return String(p || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .pop()?.toLowerCase() || '';
}

async function _verifyPermission(handle) {
    try {
        const opts = { mode: 'read' };
        if ((await handle.queryPermission(opts)) === 'granted') return true;
        if ((await handle.requestPermission(opts)) === 'granted') return true;
    } catch { /* requestPermission needs a user gesture; fall through */ }
    return false;
}

/** Recursively index every file under the granted folder by basename. */
async function _buildIndex(dirHandle) {
    const map = new Map();
    async function walk(handle) {
        for await (const [name, child] of handle.entries()) {
            if (child.kind === 'file') {
                const key = name.toLowerCase();
                if (!map.has(key)) map.set(key, child); // first wins on dup basenames
            } else if (child.kind === 'directory') {
                await walk(child);
            }
        }
    }
    await walk(dirHandle);
    return map;
}

/**
 * Ensure a readable reference folder is available.
 *
 * MUST be called during a user gesture the first time it may prompt (it can
 * open the directory picker or a permission dialog). Subsequent calls in the
 * same session are silent.
 *
 * @param {{ prompt?: boolean }} [opts]  prompt=false → never show UI, just
 *                                       report whether access already exists.
 * @returns {Promise<boolean>} true when reference bytes can be read.
 */
export async function ensureReferenceAccess({ prompt = true } = {}) {
    if (!HAS_FS) return false;

    // Already primed this session.
    if (_dirHandle && _indexPromise && await _verifyPermission(_dirHandle)) {
        return true;
    }

    // Try a persisted handle from a previous session.
    if (!_dirHandle) {
        _dirHandle = await StorageAdapter.loadPersistentHandle(HANDLE_KEY);
    }
    if (_dirHandle && !(await _verifyPermission(_dirHandle))) {
        if (!prompt) return false;
        _dirHandle = null; // permission gone; re-pick below
    }

    // Pick a folder (first run or permission revoked).
    if (!_dirHandle) {
        if (!prompt) return false;
        try {
            _dirHandle = await globalThis.showDirectoryPicker({
                id: 'cem-reference-data',
                mode: 'read',
            });
        } catch {
            return false; // user cancelled
        }
        if (!(await _verifyPermission(_dirHandle))) { _dirHandle = null; return false; }
        await StorageAdapter.savePersistentHandle(HANDLE_KEY, _dirHandle);
    }

    _indexPromise = _buildIndex(_dirHandle);
    await _indexPromise;
    return true;
}

/** True once a reference folder is granted + indexed this session. */
export function hasReferenceAccess() {
    return Boolean(_dirHandle && _indexPromise);
}

/**
 * Read a reference file's bytes by name or stored path. Returns a File/Blob, or
 * null if access isn't granted or no file with that basename exists.
 *
 * @param {string} nameOrPath  local_path or filename of the reference file.
 * @returns {Promise<File|null>}
 */
export async function readReferenceBlob(nameOrPath) {
    if (!_indexPromise) {
        const ok = await ensureReferenceAccess({ prompt: false });
        if (!ok) return null;
    }
    const index = await _indexPromise;
    const fh = index.get(_basename(nameOrPath));
    if (!fh) return null;
    try {
        return await fh.getFile();
    } catch {
        return null;
    }
}
