// [FILE: js/analysis.js]
import { getWatcherStatus, saveJobRequest, getInstalledScripts, getSpots, getExternalFiles } from './storage.js';

let heartbeatInterval = null;
let isWatcherOnline = false;
let currentScript = null;

// UI Elements
const els = {
    popup: null,
    statusIndicator: null,
    statusText: null,
    offlineHelp: null,
    runBtn: null,
    closeBtn: null,
    scriptSelect: null,
    fileSelector: null,
    dynamicForm: null,
    paramsContainer: null,
    jobNameInput: null
};

export function initAnalysis() {
    // 1. Locate Elements
    els.popup = document.getElementById('analysis-popup');
    els.statusIndicator = document.getElementById('watcher-indicator');
    els.statusText = document.getElementById('watcher-status-text');
    els.offlineHelp = document.getElementById('watcher-offline-help');
    els.runBtn = document.getElementById('btn-run-analysis');
    els.closeBtn = document.getElementById('close-analysis-btn');
    els.scriptSelect = document.getElementById('analysis-script-select');
    els.fileSelector = document.getElementById('analysis-file-selector');
    els.dynamicForm = document.getElementById('analysis-dynamic-form');
    els.paramsContainer = document.getElementById('dynamic-params-container');
    els.jobNameInput = document.getElementById('analysis-job-name');

    // 2. Event Listeners
    const openBtn = document.getElementById('analysis-btn');
    if (openBtn) openBtn.onclick = () => {
        els.popup.style.display = 'flex';
        
        // --- ADD THESE RESET LINES ---
        if (els.jobNameInput) els.jobNameInput.value = "";
        els.fileSelector.innerHTML = '<p style="padding:10px; color:#999;">Select a script first...</p>';
        els.paramsContainer.style.display = 'none';
        currentScript = null;
        // -----------------------------

        checkStatus();
        loadScripts();
        startHeartbeat();
    };

    if (els.closeBtn) els.closeBtn.onclick = () => {
        els.popup.style.display = 'none';
        if (heartbeatInterval) clearInterval(heartbeatInterval);
    };

    if (els.runBtn) els.runBtn.onclick = handleRunClick;

    if (els.scriptSelect) {
        els.scriptSelect.onchange = (e) => loadScriptParams(e.target.value);
    }
}

function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(checkStatus, 3000);
}

async function checkStatus() {
    const status = await getWatcherStatus();
    
    // Check if heartbeat is recent (< 15 seconds)
    const now = Date.now();
    const lastActive = status?.last_active_ts ? new Date(status.last_active_ts).getTime() : 0;
    const diff = (now - lastActive) / 1000; 

    isWatcherOnline = diff < 15; 

    if (isWatcherOnline) {
        els.statusIndicator.style.color = '#4CAF50'; // Green
        els.statusText.textContent = 'Watcher Online';
        els.runBtn.disabled = false;
        if (els.offlineHelp) els.offlineHelp.style.display = 'none';
        
        // Auto-refresh scripts if we connected for the first time
        if (els.scriptSelect.options.length <= 1) loadScripts();
    } else {
        els.statusIndicator.style.color = '#F44336'; // Red
        els.statusText.textContent = 'Watcher Offline';
        els.runBtn.disabled = true;
        if (els.offlineHelp) els.offlineHelp.style.display = 'block';
    }
}

async function loadScripts() {
    els.scriptSelect.innerHTML = '<option value="">Loading...</option>';

    // Fetch ONLY real installed scripts (No Mocks)
    const installedScripts = await getInstalledScripts(); 
    
    els.scriptSelect.innerHTML = '<option value="">-- Select Script --</option>';
    
    if (installedScripts.length === 0) {
        const opt = document.createElement('option');
        opt.disabled = true;
        opt.textContent = isWatcherOnline 
            ? "No scripts found (Check GitHub Repo)" 
            : "Connect Watcher to load scripts";
        els.scriptSelect.appendChild(opt);
        return;
    }

    installedScripts.forEach(script => {
        const opt = document.createElement('option');
        opt.value = script.id;
        opt.textContent = script.name;
        // Store the metadata JSON directly in the DOM
        opt.dataset.json = JSON.stringify(script);
        els.scriptSelect.appendChild(opt);
    });
}

function loadScriptParams(scriptId) {
    if (!scriptId) {
        els.paramsContainer.style.display = 'none';
        els.fileSelector.innerHTML = '<p style="padding:10px; color:#999;">Select a script first...</p>';
        return;
    }

    // Retrieve script metadata from option
    const opt = els.scriptSelect.querySelector(`option[value="${scriptId}"]`);
    currentScript = JSON.parse(opt.dataset.json);

    // Render Inputs
    renderFileSelector(currentScript.inputs);
    renderDynamicForm(currentScript.parameters);
    els.paramsContainer.style.display = 'block';
}

function renderFileSelector(inputConfig) {
    const spots = getSpots();
    const externalFiles = getExternalFiles();
    
    els.fileSelector.innerHTML = "";
    let hasFiles = false;

    // Helper: Check compatibility
    const isCompatible = (fileType, fileName) => {
        const accepts = inputConfig.accepts || [];
        if (accepts.length === 0) return true;
        return accepts.some(type => 
            (fileType && fileType.startsWith(type)) || 
            (fileName && fileName.toLowerCase().endsWith('.' + type)) ||
            (type === 'audio' && (fileName.endsWith('.wav') || fileName.endsWith('.mp3')))
        );
    };

    // 1. List Native Spots
    spots.forEach(spot => {
        // Native filter: only show if audio exists (since this is mostly for audio scripts)
        if (inputConfig.accepts.includes('audio') && !spot.audio_local_filename) return;
        
        hasFiles = true;
        const div = document.createElement("div");
        div.innerHTML = `
            <label style="display:flex; align-items:center; gap:8px; padding:5px; cursor:pointer;">
                <input type="checkbox" class="analysis-input-checkbox" value="SPOT:${spot.spotId}"> 
                <strong>${spot.name}</strong> 
                <span style="font-size:0.8rem; color:#666;">(Spot Audio)</span>
            </label>`;
        els.fileSelector.appendChild(div);
    });

    // 2. List External Files
    externalFiles.forEach(file => {
        if (!isCompatible(file.type, file.name)) return;

        hasFiles = true;
        const div = document.createElement("div");
        div.innerHTML = `
            <label style="display:flex; align-items:center; gap:8px; padding:5px; cursor:pointer;">
                <input type="checkbox" class="analysis-input-checkbox" value="EXT:${file.id}"> 
                <strong>${file.name}</strong> 
                <span style="font-size:0.8rem; color:#2196F3;">(External)</span>
            </label>`;
        els.fileSelector.appendChild(div);
    });

    if (!hasFiles) {
        els.fileSelector.innerHTML = "<p style='padding:10px'>No compatible files found.</p>";
    }
}

function renderDynamicForm(params) {
    els.dynamicForm.innerHTML = "";
    
    if (!params || params.length === 0) {
        els.dynamicForm.innerHTML = "<p style='color:#666; font-size:0.9rem;'>No parameters to configure.</p>";
        return;
    }

    params.forEach(param => {
        const row = document.createElement('div');
        row.className = 'param-row';

        const label = document.createElement('label');
        label.className = 'param-label';
        label.textContent = param.label;
        row.appendChild(label);

        if (param.description) {
            const desc = document.createElement('small');
            desc.className = 'param-desc';
            desc.textContent = param.description;
            row.appendChild(desc);
        }

        let input;

        if (param.type === 'slider') {
            input = document.createElement('input');
            input.type = 'range';
            input.min = param.min;
            input.max = param.max;
            input.step = param.step;
            input.value = param.default;
            input.dataset.paramId = param.id;

            const valDisplay = document.createElement('span');
            valDisplay.className = 'range-value';
            valDisplay.textContent = param.default;
            input.oninput = () => valDisplay.textContent = input.value;
            row.insertBefore(valDisplay, label.nextSibling);
        } 
        else if (param.type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.value = param.default;
            input.dataset.paramId = param.id;
        }
        // Note: 'file_picker' removed as per new requirements. 
        // If the script needs fixed files, the Watcher handles it invisibly.

        if(input) row.appendChild(input);
        els.dynamicForm.appendChild(row);
    });
}

async function handleRunClick() {
    if (!currentScript) return;

    // 1. Gather Job Name
    const jobName = els.jobNameInput ? els.jobNameInput.value.trim() : "";
    if (!jobName) return alert("⚠️ Please provide a required Job Name.");

    // 2. Gather Inputs
    const checkboxes = document.querySelectorAll('.analysis-input-checkbox:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);
    
    if (selectedIds.length === 0) return alert("Please select at least one input data source.");

    const spots = getSpots();
    const externalFiles = getExternalFiles();
    const filePaths = [];

    selectedIds.forEach(idStr => {
        const [type, id] = idStr.split(':');
        if (type === 'SPOT') {
            const s = spots.find(sp => sp.spotId === id);
            if (s && s.audio_local_filename) filePaths.push(s.audio_local_filename);
        } else if (type === 'EXT') {
            const f = externalFiles.find(ef => ef.id === id);
            if (f && f.local_path) filePaths.push(f.local_path);
        }
    });

    // 3. Gather Parameters
    const params = {};
    const inputs = els.dynamicForm.querySelectorAll('[data-param-id]');
    
    for (const input of inputs) {
        params[input.dataset.paramId] = input.value;
    }

    // 4. Build Job Request
    const jobData = {
        job_name: jobName,
        script_name: currentScript.script_file,
        input_files: filePaths,
        parameters: params 
    };

    try {
        els.runBtn.textContent = "Queuing...";
        els.runBtn.disabled = true;
        
        await saveJobRequest(jobData);
        
        alert("✅ Job Queued Successfully!");
        els.popup.style.display = 'none';
        els.jobNameInput.value = "";
    } catch (e) {
        alert("Error: " + e.message);
    } finally {
        els.runBtn.textContent = "🚀 Queue Job";
        els.runBtn.disabled = false;
    }
}