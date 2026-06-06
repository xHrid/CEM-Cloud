/**
 * imageUtils.js — Client-side image safety cap (near-lossless)
 *
 * Why this exists
 * ---------------
 * Modern browsers give IndexedDB a large quota (a percentage of free disk —
 * usually gigabytes), so normal photos are NOT a storage problem and we keep
 * them at full resolution and quality. This module is only a SAFETY NET against
 * pathologically large images (e.g. 48 MP / 100 MP phone modes producing
 * 8000×6000+ frames), which it caps to a generous maximum edge at near-lossless
 * JPEG quality. Anything at or under the cap is stored byte-for-byte unchanged.
 *
 * It is intentionally gentle: a typical 12 MP phone photo (≈4032×3024) is under
 * the cap and passes through untouched.
 *
 * Pure utility module — no app state, safe to import anywhere.
 */

/** Cap for the longest edge (px). Generous — only enormous frames are touched. */
const MAX_EDGE = 4096;

/** Near-lossless JPEG quality used only when a cap actually applies. */
const JPEG_QUALITY = 0.92;

/**
 * Downscale + re-encode an image File/Blob. Returns a new JPEG Blob when the
 * image is larger than MAX_EDGE; otherwise returns the original unchanged.
 *
 * Always falls back to the original input on any failure (decode error,
 * non-image, canvas blocked) so saving a spot never breaks because of resizing.
 *
 * @param {File|Blob} file        The source image.
 * @param {number}   [maxEdge]    Max width/height in px.
 * @param {number}   [quality]    JPEG quality 0–1.
 * @returns {Promise<Blob>}       Resized JPEG blob, or the original file.
 */
export async function downscaleImage(file, maxEdge = MAX_EDGE, quality = JPEG_QUALITY) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;
    // GIF/SVG: re-encoding would drop animation/vectors — leave them alone.
    if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;

    try {
        const bitmap = await _decode(file);
        const { width, height } = bitmap;
        const longest = Math.max(width, height);

        // Already small enough — keep the original bytes.
        if (longest <= maxEdge) {
            _close(bitmap);
            return file;
        }

        const scale = maxEdge / longest;
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { _close(bitmap); return file; }
        ctx.drawImage(bitmap, 0, 0, w, h);
        _close(bitmap);

        const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', quality)
        );

        // Use the resized version only if it actually came out smaller.
        if (blob && blob.size > 0 && blob.size < file.size) return blob;
        return file;
    } catch (e) {
        console.warn('[imageUtils] downscale failed, keeping original:', e.message);
        return file;
    }
}

/**
 * Decode a Blob into something drawable. Prefers createImageBitmap (fast, off
 * the main thread); falls back to an <img> + object URL where unsupported.
 *
 * @param {Blob} file
 * @returns {Promise<ImageBitmap|HTMLImageElement>}
 */
async function _decode(file) {
    if (typeof createImageBitmap === 'function') {
        return await createImageBitmap(file);
    }
    return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
        img.src = url;
    });
}

/** Release an ImageBitmap if the platform created one. */
function _close(bitmap) {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
}
