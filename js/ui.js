import {
    getSpots,
    saveExternalFile,
    resolveMasterConflict,
    getLocalState,
} from "./storage.js";
import {
    generateSyncReport,
    syncUp,
    syncDown,
    syncBatch,
    getAllProjectsSyncStatus,
} from "./media_sync.js";
import { createProject, switchProject, renameProject } from "./storage.js";
import { initAnalysis } from "./analysis.js";

// 1. Instantly react to data changes (like adding a spot)
window.addEventListener('data-updated', updateSyncIndicators);
window.addEventListener('storage-ready', updateSyncIndicators);

// 2. Global Sync Indicator Function
async function updateSyncIndicators() {
    const syncManagerBtn = document.getElementById("btn-sync-manager");
    if(syncManagerBtn) syncManagerBtn.textContent = "Checking Sync...";

    try {
        const statuses = await getAllProjectsSyncStatus();
        const allSynced = Object.values(statuses).every(s => s === true);
        
        // Update the main sidebar button
        if(syncManagerBtn) {
            syncManagerBtn.textContent = allSynced ? "✅ Sync Manager" : "⚠️ Sync Manager";
            // Optional: You can style it via CSS or JS to stand out
            syncManagerBtn.style.color = allSynced ? "green" : "#b8860b"; 
        }

        // If the Sync Modal is actively open, update its internals live
        const globalIndicator = document.getElementById("global-sync-status");
        if (globalIndicator) {
            globalIndicator.textContent = allSynced ? "✅" : "⚠️";
            globalIndicator.title = allSynced ? "All projects synced" : "Some projects have unsynced files";
            
            const projectSelect = document.getElementById("sync-project-select");
            const state = getLocalState();
            if (projectSelect && state.projects) {
                const currentVal = projectSelect.value;
                projectSelect.innerHTML = "";
                state.projects.forEach(p => {
                    const isSynced = statuses[p.id];
                    const icon = isSynced ? "✅" : "⚠️";
                    const opt = document.createElement("option");
                    opt.value = p.id;
                    opt.textContent = `${icon} ${p.name}`;
                    if (p.id === currentVal) opt.selected = true;
                    projectSelect.appendChild(opt);
                });
            }
        }
    } catch(e) {
        console.warn("Sync check failed", e);
        if(syncManagerBtn) syncManagerBtn.textContent = "Sync Manager";
    }
}

// 3. Catch the Background Sync Progress Events
window.addEventListener('sync-progress', (e) => {
    const { percent, currentFile, fails } = e.detail;
    const progressBar = document.getElementById("sync-progress-bar");
    const progressLabel = document.getElementById("sync-progress-label");
    
    // Only update DOM if the modal is actually open
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressLabel) progressLabel.textContent = `Processing: ${currentFile.split("/").pop()} (${fails} errors)`;
});

window.addEventListener('sync-batch-complete', async (e) => {
    const progressContainer = document.getElementById("sync-progress-container");
    const toolbar = document.getElementById("sync-toolbar");
    
    if (progressContainer) progressContainer.style.display = "none";
    if (toolbar) {
        toolbar.style.pointerEvents = "auto";
        toolbar.style.opacity = "1";
    }

    alert(`Batch ${e.detail.direction} complete.`);
    
    // Refresh UI entirely
    updateSyncIndicators();
    const modal = document.getElementById("sync-modal");
    if (modal && modal.style.display !== "none") {
        const state = getLocalState();
        const projectSelect = document.getElementById("sync-project-select");
        const activeProjId = projectSelect ? projectSelect.value : state.currentProjectId;
        const newReport = await generateSyncReport(activeProjId);
        renderSyncDashboard(newReport);
    }
});

document.addEventListener("DOMContentLoaded", () => {
    const projectSelect = document.getElementById("project-select");
    const btnNewProject = document.getElementById("btn-new-project");
    const btnRenameProject = document.getElementById("btn-rename-project");

    function renderProjectList() {
        const state = getLocalState();
        if (!state.projects) return; // Not ready

        projectSelect.innerHTML = "";
        state.projects.forEach((p) => {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = p.name;
            if (p.id === state.currentProjectId) opt.selected = true;
            projectSelect.appendChild(opt);
        });
    }

    if (projectSelect) {
        projectSelect.addEventListener("change", async (e) => {
            try {
                await switchProject(e.target.value);
                // 'project-changed' event will trigger map refresh
            } catch (err) {
                alert(err.message);
            }
        });

        btnNewProject.onclick = async () => {
            const name = prompt("Enter new project name:", "New Project");
            if (name) {
                await createProject(name);
                renderProjectList();
            }
        };

        btnRenameProject.onclick = async () => {
            const state = getLocalState();
            const currentName =
                projectSelect.options[projectSelect.selectedIndex].text;
            const newName = prompt("Rename project:", currentName);
            if (newName && newName !== currentName) {
                await renameProject(state.currentProjectId, newName);
                renderProjectList();
            }
        };
    }

    // Listen for updates to re-render the list
    window.addEventListener("storage-ready", renderProjectList);
    window.addEventListener("project-changed", renderProjectList);
    const menuToggle = document.getElementById("menu-toggle");
    const controls = document.getElementById("controls");
    if (menuToggle) menuToggle.onclick = () => controls.classList.toggle("open");

    const setupPopup = (openId, popupId, closeId) => {
        const openBtn = document.getElementById(openId);
        const closeBtn = document.getElementById(closeId);
        const popup = document.getElementById(popupId);
        if (openBtn) openBtn.onclick = () => (popup.style.display = "flex");
        if (closeBtn) closeBtn.onclick = () => (popup.style.display = "none");
    };

    setupPopup("open-form", "popup-form", "close-form");
    setupPopup(null, "add-site-popup-form", "close-add-site-form");
    initAnalysis();
    
    const conflictModal = document.getElementById("conflict-modal");

    document.addEventListener("master-sync-conflict", (e) => {
        const { localCount, remoteCount } = e.detail;

        document.getElementById("conflict-msg").innerHTML = `
            Master Data mismatch detected.<br>
            <strong>Local Spots:</strong> ${localCount} <br>
            <strong>Drive Spots:</strong> ${remoteCount}
        `;
        conflictModal.style.display = "flex";
    });

    document.getElementById("btn-conflict-pull").onclick = () => {
        resolveMasterConflict("pull");
        conflictModal.style.display = "none";
    };

    document.getElementById("btn-conflict-push").onclick = () => {
        resolveMasterConflict("push");
        conflictModal.style.display = "none";
    };

    document.getElementById("btn-conflict-merge").onclick = () => {
        resolveMasterConflict("merge");
        conflictModal.style.display = "none";
    };

    document.getElementById("btn-conflict-cancel").onclick = () => {
        conflictModal.style.display = "none";
    };

    if (document.querySelector(".add_site")) {
        document.querySelector(".add_site").onclick = () =>
            (document.getElementById("add-site-popup-form").style.display = "flex");
    }

    const syncBtn = document.getElementById("btn-sync-manager");
    document.addEventListener("click", async (e) => {
        if (e.target && e.target.id === "btn-sync-manager") {
            openSyncModal();
        }
    });

    const importBtn = document.getElementById("import-media-btn");
    const importPopup = document.getElementById("import-media-popup");
    const spotContainer = document.getElementById("spot-selection-container");
    const importForm = document.getElementById("import-media-form");

    if (importBtn) {
        importBtn.onclick = () => {
            const spots = getSpots();
            spotContainer.innerHTML = "";
            if (!spots || spots.length === 0) {
                spotContainer.innerHTML = "<p>No spots found. Create a spot first.</p>";
            } else {
                spots.forEach((spot) => {
                    const div = document.createElement("div");
                    div.innerHTML = `<label><input type="checkbox" name="selected_spot" value="${spot.spotId}"> ${spot.name}</label>`;
                    spotContainer.appendChild(div);
                });
            }
            importPopup.style.display = "flex";
        };

        const cancelImport = document.getElementById("cancel-import-btn");
        if (cancelImport)
            cancelImport.onclick = () => (importPopup.style.display = "none");

        importForm.onsubmit = async (e) => {
            e.preventDefault();

            const submitBtn = importForm.querySelector('button[type="submit"]');
            const originalText = submitBtn.textContent;
            submitBtn.textContent = "Importing...";
            submitBtn.disabled = true;

            try {
                const checkedBoxes = spotContainer.querySelectorAll(
                    'input[name="selected_spot"]:checked',
                );
                const selectedSpotIds = Array.from(checkedBoxes).map((cb) => cb.value);

                const fileInput = document.getElementById("external-file-input");
                const files = Array.from(fileInput.files);

                if (selectedSpotIds.length === 0)
                    throw new Error("Please select at least one spot.");
                if (files.length === 0) throw new Error("Please select files.");

                for (let file of files) {
                    await saveExternalFile(file, selectedSpotIds);
                }

                alert(
                    `Success! Queued ${files.length} files. Open Sync Manager to push to Drive.`,
                );
                importPopup.style.display = "none";
                importForm.reset();
            } catch (err) {
                console.error(err);
                alert("Import Failed: " + err.message);
            } finally {
                submitBtn.textContent = originalText;
                submitBtn.disabled = false;
            }
        };
    }
});

async function runBatchSync(items, direction) {
    if (!confirm(`Are you sure you want to ${direction} ${items.length} files?`)) return;

    const progressContainer = document.getElementById("sync-progress-container");
    const toolbar = document.getElementById("sync-toolbar");

    // Lock the UI
    if(toolbar) {
        toolbar.style.pointerEvents = "none";
        toolbar.style.opacity = "0.5";
    }
    if(progressContainer) progressContainer.style.display = "block";

    try {
        // We no longer pass the callback; the Event Listeners handle it in the background
        await syncBatch(items, direction); 
    } catch (err) {
        alert(err.message);
        if(toolbar) {
            toolbar.style.pointerEvents = "auto";
            toolbar.style.opacity = "1";
        }
        if(progressContainer) progressContainer.style.display = "none";
    }
}

function renderSyncDashboard(report) {
    const container = document.getElementById("sync-list");
    container.innerHTML = "";

    const groups = { Metadata: [], Sites: [], Spots: {} };
    const pushList = [];
    const pullList = [];

    report.forEach((item) => {
        const parts = item.name.split("/");
        // parts[0] = ProjectFolder, parts[1] = 'spots' | 'sites', parts[2] = SpotName
        if (item.name === "master_data.json") {
            groups.Metadata.push(item);
        } else if (parts[1] === "sites") {
            groups.Sites.push(item);
        } else if (parts[1] === "spots") {
            const spotName = parts[2] || "Unknown";
            if (!groups.Spots[spotName]) groups.Spots[spotName] = [];
            groups.Spots[spotName].push(item);
        }

        if (item.isLocal && !item.isDrive) pushList.push(item);
        if (!item.isLocal && item.isDrive) pullList.push(item);
    });

    document.getElementById("count-push").textContent = pushList.length;
    document.getElementById("count-pull").textContent = pullList.length;

    const btnPush = document.getElementById("btn-push-all");
    const btnPull = document.getElementById("btn-pull-all");

    btnPush.disabled = pushList.length === 0;
    btnPull.disabled = pullList.length === 0;
    document.getElementById("sync-status-text").textContent = "Ready";

    btnPush.onclick = () => runBatchSync(pushList, "push");
    btnPull.onclick = () => runBatchSync(pullList, "pull");

    const createRow = (item) => {
        let statusHtml = "";
        let actionBtn = "";

        if (item.isLocal && item.isDrive) {
            statusHtml = `<span style="color:green">✅ Synced</span>`;
        } else if (item.isLocal && !item.isDrive) {
            statusHtml = `<span style="color:orange">🏠 Local Only</span>`;
            actionBtn = `<button class="mini-sync-btn" data-action="push" data-name="${item.name}">⬆</button>`;
        } else if (!item.isLocal && item.isDrive) {
            statusHtml = `<span style="color:blue">☁️ Drive Only</span>`;
            actionBtn = `<button class="mini-sync-btn" data-action="pull" data-id="${item.driveId}" data-name="${item.name}">⬇</button>`;
        }

        const displayName = item.name.split("/").pop();

        return `
            <div class="sync-row">
                <div class="sync-file-name" title="${item.name}">${displayName}</div>
                <div class="sync-status">${statusHtml}</div>
                <div class="sync-action">${actionBtn}</div>
            </div>
        `;
    };

    if (groups.Metadata.length > 0) {
        container.innerHTML += `<div class="sync-group-header">📂 System Files</div>`;
        groups.Metadata.forEach((item) => (container.innerHTML += createRow(item)));
    }

    if (groups.Sites.length > 0) {
        container.innerHTML += `<div class="sync-group-header">🗺️ Sites</div>`;
        groups.Sites.forEach((item) => (container.innerHTML += createRow(item)));
    }

    Object.keys(groups.Spots)
        .sort()
        .forEach((spotName) => {
            const items = groups.Spots[spotName];
            const allSynced = items.every((i) => i.isLocal && i.isDrive);
            const color = allSynced ? "#4CAF50" : "#333";

            container.innerHTML += `<div class="sync-group-header" style="border-left: 4px solid ${color}">📍 ${spotName.replace(/_/g, " ")}</div>`;
            items.forEach((item) => (container.innerHTML += createRow(item)));
        });

    container.querySelectorAll(".mini-sync-btn").forEach((btn) => {
        btn.onclick = async (e) => {
            const el = e.target;
            const action = el.dataset.action;
            const name = el.dataset.name;
            const id = el.dataset.id;

            el.disabled = true;
            el.innerHTML = "⏳";

            try {
                if (action === "push") await syncUp(name);
                if (action === "pull") await syncDown(id, name);
                const newReport = await generateSyncReport();
                renderSyncDashboard(newReport);
            } catch (err) {
                alert("Failed: " + err.message);
                el.innerHTML = "❌";
            }
        };
    });
}

async function openSyncModal() {
    let modal = document.getElementById("sync-modal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "sync-modal";
        modal.className = "import-popup-overlay";
        modal.style.display = "flex";
        modal.innerHTML = `
            <div class="import-popup-content" style="max-width: 800px; max-height:85vh; display:flex; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <h3>☁️ Sync Manager</h3>
                    <button id="close-sync" style="background:transparent; border:none; font-size:1.2rem; cursor:pointer;">✖</button>
                </div>
                
                <div id="sync-toolbar" style="display:flex; gap:10px; margin-bottom:15px; padding:10px; background:#f5f5f5; border-radius:8px;">
                    <div style="flex:1;">
                        <strong>Status:</strong> <span id="sync-status-text">Scanning...</span>
                    </div>
                    <button id="btn-push-all" class="sync-action-btn" disabled>⬆ Push All (<span id="count-push">0</span>)</button>
                    <button id="btn-pull-all" class="sync-action-btn" disabled>⬇ Pull All (<span id="count-pull">0</span>)</button>
                </div>

                <div id="sync-progress-container" style="display:none; margin-bottom:10px;">
                    <div style="background:#eee; height:10px; border-radius:5px; overflow:hidden;">
                        <div id="sync-progress-bar" style="width:0%; background:#4CAF50; height:100%; transition:width 0.3s;"></div>
                    </div>
                    <div id="sync-progress-label" style="font-size:0.8rem; text-align:center; margin-top:5px;">Processing...</div>
                </div>

                <div id="sync-list" style="flex:1; overflow-y:auto; padding-right:5px;"></div>
            </div>
        `;
        document.body.appendChild(modal);
        document.getElementById("close-sync").onclick = () =>
            (modal.style.display = "none");
    } else {
        modal.style.display = "flex";
        document.getElementById("sync-list").innerHTML =
            "<p style='text-align:center; padding:20px;'>Scanning files...</p>";
        document.getElementById("sync-progress-container").style.display = "none";
    }

    const modalContent = document.querySelector(
        "#sync-modal .import-popup-content",
    );

    // Insert header controls if not present
    if (!document.getElementById("sync-header-controls")) {
        const header = document.createElement("div");
        header.id = "sync-header-controls";
        header.style.marginBottom = "15px";
        header.style.padding = "10px";
        header.style.background = "#f9f9f9";
        header.style.borderRadius = "8px";
        header.style.display = "flex";
        header.style.alignItems = "center";
        header.style.gap = "10px";

        header.innerHTML = `
            <span id="global-sync-status" style="font-size: 1.2rem;">Checking...</span>
            <select id="sync-project-select" style="flex:1; margin:0;"></select>
        `;

        // Insert after the title
        const titleRow = modalContent.children[0];
        titleRow.after(header);

        // Change Listener
        document.getElementById("sync-project-select").onchange = async (e) => {
            const report = await generateSyncReport(e.target.value);
            renderSyncDashboard(report); // Assuming renderSyncDashboard clears and redraws list
        };
    }

    // 2. POPULATE & CHECK STATUS
    const projectSelect = document.getElementById("sync-project-select");
    const globalIndicator = document.getElementById("global-sync-status");
    const state = getLocalState();

    // Set loading state
    globalIndicator.textContent = "⏳";
    projectSelect.innerHTML = "<option>Loading...</option>";

    // Fetch statuses
    const statuses = await getAllProjectsSyncStatus();

    // Determine Global Status (Yellow if ANY project is unsynced)
    const allSynced = Object.values(statuses).every((s) => s === true);
    globalIndicator.textContent = allSynced ? "✅" : "⚠️";
    globalIndicator.title = allSynced
        ? "All projects synced"
        : "Some projects have unsynced files";

    // Build Options
    projectSelect.innerHTML = "";
    state.projects.forEach((p) => {
        const isSynced = statuses[p.id];
        const icon = isSynced ? "✅" : "⚠️";
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${icon} ${p.name}`;
        if (p.id === state.currentProjectId) opt.selected = true;
        projectSelect.appendChild(opt);
    });

    // Initial Render for Active Project
    const report = await generateSyncReport(state.currentProjectId);
    renderSyncDashboard(report);
}

function renderSyncRows(report) {
    const container = document.getElementById("sync-list");
    container.innerHTML = "";

    if (report.length === 0) {
        container.innerHTML = "No files found to sync.";
        return;
    }

    report.forEach((item) => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.padding = "8px";
        row.style.borderBottom = "1px solid #eee";

        let actionBtn = "";
        let statusText = "";

        if (item.isLocal && !item.isDrive) {
            statusText = "🏠 Local Only";
            actionBtn = `<button class="sync-action-btn" data-action="push" data-name="${item.name}">⬆ Push</button>`;
        } else if (!item.isLocal && item.isDrive) {
            statusText = "☁️ Drive Only";
            actionBtn = `<button class="sync-action-btn" data-action="pull" data-id="${item.driveId}" data-name="${item.name}">⬇ Pull</button>`;
        } else if (item.isLocal && item.isDrive) {
            statusText = "✅ Synced";
        }

        row.innerHTML = `
            <div style="flex:1; overflow:hidden; text-overflow:ellipsis;">${item.name}</div>
            <div style="width:100px; font-size:0.8rem; color:#555;">${statusText}</div>
            <div>${actionBtn}</div>
        `;
        container.appendChild(row);
    });

    container.querySelectorAll(".sync-action-btn").forEach((btn) => {
        btn.onclick = async (e) => {
            const el = e.target;
            const action = el.dataset.action;
            const name = el.dataset.name;
            const id = el.dataset.id;

            el.disabled = true;
            el.textContent = "⏳";

            try {
                if (action === "push") await syncUp(name);
                if (action === "pull") await syncDown(id, name);
                const newReport = await generateSyncReport();
                renderSyncRows(newReport);
            } catch (err) {
                alert("Sync failed: " + err.message);
                el.disabled = false;
                el.textContent = "Retry";
            }
        };
    });
}
