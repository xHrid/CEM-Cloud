import { getSpots, saveExternalFile } from './storage.js';
import { generateSyncReport, syncUp, syncDown } from './media_sync.js';

document.addEventListener("DOMContentLoaded", () => {
    const menuToggle = document.getElementById("menu-toggle");
    const controls = document.getElementById("controls");
    if(menuToggle) menuToggle.onclick = () => controls.classList.toggle("open");

    const setupPopup = (openId, popupId, closeId) => {
        const openBtn = document.getElementById(openId);
        const closeBtn = document.getElementById(closeId);
        const popup = document.getElementById(popupId);
        if(openBtn) openBtn.onclick = () => popup.style.display = "flex";
        if(closeBtn) closeBtn.onclick = () => popup.style.display = "none";
    };

    setupPopup("open-form", "popup-form", "close-form");
    setupPopup(null, "add-site-popup-form", "close-add-site-form");
    
    if(document.querySelector(".add_site")) {
        document.querySelector(".add_site").onclick = () => document.getElementById("add-site-popup-form").style.display = "flex";
    }
    
    const syncBtn = document.getElementById("btn-sync-manager");
    document.addEventListener('click', async (e) => {
        if(e.target && e.target.id === 'btn-sync-manager') {
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
                spots.forEach(spot => {
                    const div = document.createElement("div");
                    div.innerHTML = `<label><input type="checkbox" name="selected_spot" value="${spot.spotId}"> ${spot.name}</label>`;
                    spotContainer.appendChild(div);
                });
            }
            importPopup.style.display = "flex";
        };
        
        const cancelImport = document.getElementById("cancel-import-btn");
        if(cancelImport) cancelImport.onclick = () => importPopup.style.display = "none";
        
        importForm.onsubmit = async (e) => {
            e.preventDefault();
            
            const submitBtn = importForm.querySelector('button[type="submit"]');
            const originalText = submitBtn.textContent;
            submitBtn.textContent = "Importing...";
            submitBtn.disabled = true;

            try {
                const checkedBoxes = spotContainer.querySelectorAll('input[name="selected_spot"]:checked');
                const selectedSpotIds = Array.from(checkedBoxes).map(cb => cb.value);
                
                const fileInput = document.getElementById("external-file-input");
                const files = Array.from(fileInput.files);

                if (selectedSpotIds.length === 0) throw new Error("Please select at least one spot.");
                if (files.length === 0) throw new Error("Please select files.");

                for (let file of files) {
                    await saveExternalFile(file, selectedSpotIds);
                }

                alert(`Success! Queued ${files.length} files. Open Sync Manager to push to Drive.`);
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


async function openSyncModal() {
    let modal = document.getElementById('sync-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'sync-modal';
        modal.className = 'import-popup-overlay';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="import-popup-content" style="max-width: 600px; max-height:80vh; overflow-y:auto;">
                <h3>Sync Manager</h3>
                <div id="sync-list" style="margin-bottom:20px;">Scanning...</div>
                <button id="close-sync" class="import-secondary-action-btn">Close</button>
            </div>
        `;
        document.body.appendChild(modal);
        document.getElementById('close-sync').onclick = () => modal.style.display = 'none';
    } else {
        modal.style.display = 'flex';
        document.getElementById('sync-list').innerHTML = "Scanning...";
    }

    try {
        const report = await generateSyncReport();
        renderSyncRows(report);
    } catch (e) {
        document.getElementById('sync-list').innerHTML = `<p style="color:red">Error: ${e.message}</p>`;
    }
}

function renderSyncRows(report) {
    const container = document.getElementById('sync-list');
    container.innerHTML = "";

    if (report.length === 0) {
        container.innerHTML = "No files found to sync.";
        return;
    }

    report.forEach(item => {
        const row = document.createElement('div');
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

    container.querySelectorAll('.sync-action-btn').forEach(btn => {
        btn.onclick = async (e) => {
            const el = e.target;
            const action = el.dataset.action;
            const name = el.dataset.name;
            const id = el.dataset.id;
            
            el.disabled = true;
            el.textContent = "⏳";
            
            try {
                if (action === 'push') await syncUp(name);
                if (action === 'pull') await syncDown(id, name);
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