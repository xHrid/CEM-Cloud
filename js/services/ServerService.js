/**
 * ServerService.js — "Connect to Server" compute backend
 *
 * Pattern : Module Pattern (IIFE-free ES module; private helpers are simply
 *           non-exported functions).
 *
 * This is the browser-side counterpart to watcher.py. Instead of writing a job
 * descriptor into jobs/queue/ and waiting for a local python watcher to pick it
 * up, server mode talks directly to the Dockerised FastAPI in cem-scripts-new:
 *
 *      1. POST /jobs                      -> create an isolated server job
 *      2. POST /jobs/{id}/upload          -> push audio (birdnet) OR the cached
 *                                            aggregate CSV (analysis steps)
 *      3. POST /jobs/{id}/run/{step}      -> launch the chosen step (async)
 *      4. GET  /jobs/{id}/tasks/{task}    -> poll until success | failed
 *      5. GET  /jobs/{id}/results         -> list produced files
 *         GET  /jobs/{id}/file?path=...   -> download each one
 *
 * Downloaded results are written into the SAME local storage layout the watcher
 * uses (<project>/jobs/results/<jobId>/...), and the job descriptor is parked in
 * jobs/completed | jobs/failed, so JobsDashboard renders server jobs with zero
 * changes. For a BirdNET run we additionally persist the produced aggregate to
 * <project>/system/database/birdnet_results.csv and append the processed file
 * names to the local cache — so the dependency/overlap logic AND later analysis
 * steps (server OR watcher) keep working exactly as before.
 *
 * The server is stateless per job, so an analysis step has no aggregate of its
 * own. We satisfy its BirdNET dependency by uploading the locally-cached
 * aggregate (kind=aggregate) — the same CSV the watcher would have produced.
 *
 * Server URL + API key are read from Config.server (see Config.js).
 *
 * Public exports:
 *   isConfigured        — true when Config.server has a baseUrl + apiKey
 *   getServerConfig     — { baseUrl, apiKey }
 *   checkServerHealth   — GET /health -> { online, steps }
 *   getServerSteps      — GET /steps  -> UI-ready script descriptor array
 *   runJobOnServer      — full upload -> run -> poll -> download orchestration
 */

import Config                    from '../core/Config.js';
import EventBus, { EVENTS }      from '../core/EventBus.js';
import * as StorageAdapter       from '../data/StorageAdapter.js';
import * as MasterData           from '../data/MasterData.js';
import { getProjectFolderName }  from '../data/projectUtils.js';
import { buildJobData }          from './AnalysisService.js';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Trailing-slash-stripped base URL, or '' if unset. */
function _base() {
    return (Config.server?.baseUrl || '').replace(/\/+$/, '');
}

/** Full URL for an API path (which must start with '/'). */
function _url(path) {
    return _base() + path;
}

/** Auth header object for authenticated endpoints. */
function _authHeaders() {
    return { 'X-API-Key': Config.server?.apiKey || '' };
}

/**
 * True when a server URL and API key are present in Config.
 * @returns {boolean}
 */
export function isConfigured() {
    return Boolean(_base() && Config.server?.apiKey);
}

/**
 * @returns {{ baseUrl: string, apiKey: string }}
 */
export function getServerConfig() {
    return { baseUrl: _base(), apiKey: Config.server?.apiKey || '' };
}

// ---------------------------------------------------------------------------
// Low-level fetch wrappers
// ---------------------------------------------------------------------------

/**
 * fetch() with an abort-based timeout. Rejects with a readable Error on
 * network failure / timeout / non-2xx.
 *
 * @param {string} url
 * @param {RequestInit} [opts]
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<Response>}
 * @private
 */
async function _fetch(url, opts = {}, timeoutMs = 30000) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
        // ngrok's free tier serves an HTML browser-warning interstitial (HTTP
        // 200, no CORS headers) instead of proxying to the server — which the
        // browser then blocks as "No Access-Control-Allow-Origin". Sending this
        // header on every request tells ngrok to skip the interstitial and pass
        // straight through. It is harmless on non-ngrok backends.
        const headers = { 'ngrok-skip-browser-warning': 'true', ...(opts.headers || {}) };
        resp = await fetch(url, { ...opts, headers, signal: ctrl.signal });
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Request timed out: ${url}`);
        // TypeError here usually means CORS / mixed-content / server unreachable
        throw new Error(`Network error reaching server (${e.message}). ` +
            `Check the URL, that the server is running, HTTPS, and CORS.`);
    } finally {
        clearTimeout(timer);
    }
    if (!resp.ok) {
        let detail = `${resp.status} ${resp.statusText}`;
        try {
            const body = await resp.clone().json();
            if (body?.detail) detail += ` — ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)}`;
        } catch { /* non-JSON body */ }
        throw new Error(detail);
    }
    return resp;
}

const _json = (url, opts, t) => _fetch(url, opts, t).then(r => r.json());

// ---------------------------------------------------------------------------
// Health + step catalogue
// ---------------------------------------------------------------------------

/**
 * Probe the server's /health endpoint (no auth required).
 *
 * @returns {Promise<{ online: boolean, steps: string[], error?: string }>}
 */
export async function checkServerHealth() {
    if (!_base()) return { online: false, steps: [], error: 'No server URL configured.' };
    try {
        const data = await _json(_url('/health'), {}, 8000);
        return { online: data?.status === 'ok', steps: data?.steps || [] };
    } catch (e) {
        return { online: false, steps: [], error: e.message };
    }
}

// API step id -> pipeline script filename (mirrors pipeline/manifest.json).
const _SCRIPT_FILE = {
    birdnet:                  'birdnet_predictions.py',
    heatmaps:                 'activity_heatmaps.py',
    temporal_stickiness:      'temporal_stickiness.py',
    spatial_stickiness:       'spatial_stickiness.py',
    migratory_classification: 'migratory_classification.py',
    solar_correlation:        'solar_correlation.py',
    daily_timeseries:         'daily_call_timeseries.py',
};

/**
 * Fetch the runnable step catalogue from the server and shape it into the same
 * descriptor objects AnalysisUI expects from installed.json — so server mode
 * works even if the watcher has never synced scripts locally.
 *
 * Every step takes a spot/date selection; only birdnet exposes the snr_db param.
 *
 * @returns {Promise<object[]>}
 */
export async function getServerSteps() {
    const steps = await _json(_url('/steps'), { headers: _authHeaders() }, 10000);
    return Object.entries(steps).map(([id, meta]) => ({
        id,
        name:        meta.name || id,
        script_file: _SCRIPT_FILE[id] || `${id}.py`,
        description: meta.description || '',
        depends_on:  meta.depends_on || [],
        inputs: [{
            type: 'spot_date_range',
            label: 'Select spots and date range',
            valid_extensions: ['.wav'],
        }],
        parameters: id === 'birdnet'
            ? [{ id: 'snr_db', label: 'SNR for noise removal (dB)', type: 'text', default: '18' }]
            : [],
    }));
}

// ---------------------------------------------------------------------------
// Local-storage input collection
// ---------------------------------------------------------------------------

/**
 * Collect the audio files (and reference files) that match the selected spots
 * and date range, returning their storage-relative paths so the bytes can be
 * read and uploaded. Mirrors the selection logic in AnalysisService.buildJobData
 * but yields individual files (not collapsed directories).
 *
 * @returns {{ audio: {path:string,name:string}[],
 *             references: {path:string,name:string,spot:string}[] }}
 * @private
 */
function _collectAudioInputs(spotIds, startDate, endDate, currentScript, spots, externalFiles) {
    const validExts = currentScript.inputs?.[0]?.valid_extensions ?? ['.wav'];
    const extRegex  = new RegExp(`\\.(${validExts.map(e => e.replace('.', '')).join('|')})$`, 'i');
    const startVal  = parseInt(startDate.replace(/-/g, ''), 10);
    const endVal    = parseInt(endDate.replace(/-/g, ''), 10);
    const spotIdSet = new Set(spotIds);

    const audio = [];
    const references = [];

    externalFiles.forEach(file => {
        if (!file.local_path || !file.name) return;
        if (!extRegex.test(file.name)) return;
        if (!file.linked_spots || !file.linked_spots.some(id => spotIdSet.has(id))) return;

        // Date filter (filenames carry _YYYYMMDD_); keep files with no date stamp.
        const m = file.name.match(/_(\d{8})_/);
        if (m) {
            const d = parseInt(m[1], 10);
            if (d < startVal || d > endVal) return;
        }

        if (file.is_reference) {
            const matchId  = spotIds.find(id => file.linked_spots.includes(id));
            const spot     = spots.find(sp => sp.spotId === matchId);
            const spotName = spot ? spot.name.replace(/\s+/g, '').toUpperCase() : (matchId || '');
            references.push({ path: file.local_path, name: file.name, spot: spotName });
        } else {
            audio.push({ path: file.local_path, name: file.name });
        }
    });

    return { audio, references };
}

// ---------------------------------------------------------------------------
// Local job-record + result persistence (mirrors the watcher's status folders)
// ---------------------------------------------------------------------------

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Write the job descriptor JSON into jobs/<status>/<jobId>.json. */
async function _writeJobRecord(projectFolder, jobId, record, status) {
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    await StorageAdapter.saveFile(blob, `${jobId}.json`, [projectFolder, 'jobs', status]);
}

/** Move the job descriptor between status folders. */
async function _moveJobRecord(projectFolder, jobId, record, fromStatus, toStatus) {
    await _writeJobRecord(projectFolder, jobId, record, toStatus);
    await StorageAdapter.deleteFile(`${projectFolder}/jobs/${fromStatus}/${jobId}.json`);
}

/** Merge new filenames into the local processed-files cache for a script. */
async function _appendProcessedCache(projectFolder, scriptFile, names) {
    if (!names.length) return;
    const path = `${projectFolder}/system/database/processed_${scriptFile}.txt`;
    let existing = [];
    try {
        const blob = await StorageAdapter.getFileBlob(path);
        if (blob) existing = (await blob.text()).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch { /* none yet */ }
    const merged = Array.from(new Set([...existing, ...names]));
    const blob   = new Blob([merged.join('\n') + '\n'], { type: 'text/plain' });
    await StorageAdapter.saveFile(blob, `processed_${scriptFile}.txt`, [projectFolder, 'system', 'database']);
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * Run one analysis step on the lab server end-to-end.
 *
 * @param {object}   opts
 * @param {string}   opts.jobName
 * @param {object}   opts.currentScript    Script descriptor (id, script_file, depends_on, …).
 * @param {string[]} opts.spotIds
 * @param {string}   opts.startDate        'YYYY-MM-DD'
 * @param {string}   opts.endDate          'YYYY-MM-DD'
 * @param {object}   opts.dynamicParams    e.g. { snr_db: '18' }
 * @param {object[]} opts.spots
 * @param {object[]} opts.externalFiles
 * @param {(msg:string)=>void} [opts.onProgress]   UI status callback.
 * @returns {Promise<{ jobId: string, status: 'completed', files: number }>}
 * @throws  {Error} with a user-facing message on any failure (the local job
 *                  record is moved to jobs/failed before throwing).
 */
export async function runJobOnServer(opts) {
    const {
        jobName, currentScript, spotIds, startDate, endDate,
        dynamicParams, spots, externalFiles, onProgress = () => {},
    } = opts;

    if (!isConfigured()) {
        throw new Error('Server is not configured. Set Config.server.baseUrl and apiKey.');
    }

    const project = MasterData.getActiveProject();
    if (!project) throw new Error('No active project. Initialise storage first.');
    const projectFolder = getProjectFolderName(project);

    const stepId    = currentScript.id;
    const isBirdnet = stepId === 'birdnet';
    const localJobId = crypto.randomUUID();

    // Assemble the descriptor (datasets/params) so the record matches a watcher job.
    const jobData = buildJobData(
        jobName, currentScript, spotIds, startDate, endDate,
        dynamicParams, spots, externalFiles,
    );

    const record = {
        ...jobData,
        job_id:     localJobId,
        job_name:   jobName || `Job ${localJobId.substring(0, 8)}`,
        project_id: project.id,
        mode:       'server',
        status:     'processing',
        created_at: new Date().toISOString(),
        server: { base_url: _base(), job_id: null, task_id: null },
    };

    // Park it in jobs/processing immediately so it shows up live in the dashboard.
    await _writeJobRecord(projectFolder, localJobId, record, 'processing');
    EventBus.emit(EVENTS.DATA_UPDATED, null);

    try {
        // 1. Create the server-side job ---------------------------------------
        onProgress('Creating job on server…');
        const created     = await _json(_url('/jobs'), { method: 'POST', headers: _authHeaders() }, 15000);
        const serverJobId = created.job_id;
        record.server.job_id = serverJobId;
        await _writeJobRecord(projectFolder, localJobId, record, 'processing');

        // 2. Upload inputs -----------------------------------------------------
        const processedNames = [];
        if (isBirdnet) {
            const { audio, references } = _collectAudioInputs(
                spotIds, startDate, endDate, currentScript, spots, externalFiles);

            // Server mode = COPIED files only. Reference imports keep no bytes in
            // the browser (only a disk path the sandbox can't read), so they can't
            // be uploaded. Skip them with a clear warning; the user should
            // re-import those as copies to analyse them on the server. (Local
            // watcher mode still handles references — it reads them off disk.)
            if (references.length) {
                const names = references.map(r => r.name).join(', ');
                console.warn(
                    `[ServerService] Skipping ${references.length} referenced file(s) — ` +
                    `server mode supports copied imports only. Re-import as copies to ` +
                    `analyse on the server: ${names}`);
                onProgress(
                    `Note: skipping ${references.length} referenced file(s) — ` +
                    `server mode supports copied imports only. Re-import them as copies.`);
            }

            if (audio.length === 0) {
                throw new Error(
                    references.length
                        ? 'All matching files were imported by reference, which the server ' +
                          'cannot analyse. Re-import them as copies and try again.'
                        : 'No audio files found for the selected spots and dates.');
            }

            // Copied audio files → one multipart request (kind=audio).
            onProgress(`Uploading ${audio.length} file(s)…`);
            const fd = new FormData();
            fd.append('kind', 'audio');
            for (const a of audio) {
                const blob = await StorageAdapter.getFileBlob(a.path);
                if (!blob) throw new Error(`Could not read local file: ${a.name}`);
                fd.append('files', blob, a.name);
                processedNames.push(a.name);
            }
            await _fetch(_url(`/jobs/${serverJobId}/upload`),
                { method: 'POST', headers: _authHeaders(), body: fd },
                20 * 60 * 1000);
        } else {
            // Analysis step: ship the locally-cached BirdNET aggregate so the
            // stateless server has the detections to analyse.
            onProgress('Uploading BirdNET aggregate…');
            const aggPath = `${projectFolder}/system/database/birdnet_results.csv`;
            const aggBlob = await StorageAdapter.getFileBlob(aggPath);
            if (!aggBlob) {
                throw new Error('No local BirdNET aggregate found. Run BirdNET ' +
                    '(locally or on the server) before this analysis.');
            }
            const fd = new FormData();
            fd.append('kind', 'aggregate');
            fd.append('files', aggBlob, 'aggregate.csv');
            await _fetch(_url(`/jobs/${serverJobId}/upload`),
                { method: 'POST', headers: _authHeaders(), body: fd }, 5 * 60 * 1000);
        }

        // 3. Launch the step ---------------------------------------------------
        onProgress('Starting analysis…');
        const runBody = {};
        if (jobData.parameters?.spots)      runBody.spots      = String(jobData.parameters.spots).split(',').filter(Boolean);
        if (jobData.parameters?.start_date) runBody.start_date = jobData.parameters.start_date;
        if (jobData.parameters?.end_date)   runBody.end_date   = jobData.parameters.end_date;
        if (isBirdnet && dynamicParams?.snr_db != null && dynamicParams.snr_db !== '') {
            const snr = Number(dynamicParams.snr_db);
            if (!Number.isNaN(snr)) runBody.snr_db = snr;
        }

        const run = await _json(_url(`/jobs/${serverJobId}/run/${stepId}`), {
            method: 'POST',
            headers: { ...
                _authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(runBody),
        }, 15000);

        const taskId = run.task_id;
        record.server.task_id = taskId;
        await _writeJobRecord(projectFolder, localJobId, record, 'processing');

        // 4. Poll the task -----------------------------------------------------
        const started = Date.now();
        const MAX_MS  = 60 * 60 * 1000;   // hard stop after 1h
        let task;
        for (;;) {
            await _sleep(2500);
            task = await _json(_url(`/jobs/${serverJobId}/tasks/${taskId}`),
                { headers: _authHeaders() }, 15000);
            const secs = Math.round((Date.now() - started) / 1000);
            onProgress(`${task.status} on server… (${secs}s)`);
            if (task.status === 'success' || task.status === 'failed') break;
            if (Date.now() - started > MAX_MS) throw new Error('Timed out waiting for the server task.');
        }

        // Always try to capture the run log for the dashboard.
        let runLog = '';
        try {
            const logResp = await _fetch(_url(`/jobs/${serverJobId}/tasks/${taskId}/log`),
                { headers: _authHeaders() }, 15000);
            runLog = await logResp.text();
        } catch { /* log optional */ }

        // 5. Failure path ------------------------------------------------------
        if (task.status === 'failed') {
            if (runLog) {
                await StorageAdapter.saveFile(
                    new Blob([runLog], { type: 'text/plain' }),
                    'error.log', [projectFolder, 'jobs', 'results', localJobId]);
            }
            record.status = 'failed';
            record.error  = task.error || 'Server task failed.';
            record.finished_at = new Date().toISOString();
            await _moveJobRecord(projectFolder, localJobId, record, 'processing', 'failed');
            EventBus.emit(EVENTS.DATA_UPDATED, null);
            throw new Error(record.error);
        }

        // 6. Download results --------------------------------------------------
        onProgress('Downloading results…');
        const { results = [] } = await _json(_url(`/jobs/${serverJobId}/results`),
            { headers: _authHeaders() }, 30000);

        let saved = 0;
        let aggregateBlob = null;
        for (const rel of results) {
            const resp = await _fetch(
                _url(`/jobs/${serverJobId}/file?path=${encodeURIComponent(rel)}`),
                { headers: _authHeaders() }, 5 * 60 * 1000);
            const blob = await resp.blob();
            const base = rel.split('/').pop();
            await StorageAdapter.saveFile(blob, base, [projectFolder, 'jobs', 'results', localJobId]);
            saved++;
            if (isBirdnet && /aggregate\.csv$/i.test(rel)) aggregateBlob = blob;
        }

        if (runLog) {
            await StorageAdapter.saveFile(
                new Blob([runLog], { type: 'text/plain' }),
                '_run.log', [projectFolder, 'jobs', 'results', localJobId]);
        }

        // 7. For BirdNET: persist aggregate + processed cache for downstream use
        if (isBirdnet) {
            if (aggregateBlob) {
                await StorageAdapter.saveFile(aggregateBlob, 'birdnet_results.csv',
                    [projectFolder, 'system', 'database']);
            }
            await _appendProcessedCache(projectFolder, currentScript.script_file, processedNames);
        }

        // 8. Mark completed ----------------------------------------------------
        record.status      = 'completed';
        record.finished_at = new Date().toISOString();
        record.result_count = saved;
        await _moveJobRecord(projectFolder, localJobId, record, 'processing', 'completed');
        EventBus.emit(EVENTS.DATA_UPDATED, null);

        onProgress(`Done — ${saved} file(s) downloaded.`);
        return { jobId: localJobId, status: 'completed', files: saved };

    } catch (e) {
        // Best-effort move to failed so the job doesn't get stuck "processing".
        try {
            record.status = 'failed';
            record.error  = record.error || e.message;
            record.finished_at = record.finished_at || new Date().toISOString();
            await _moveJobRecord(projectFolder, localJobId, record, 'processing', 'failed');
            EventBus.emit(EVENTS.DATA_UPDATED, null);
        } catch { /* record may already be moved */ }
        throw e;
    }
}
