import { saveSpot, getSpots, getExternalFiles, getLocalFileUrl } from './storage.js';

let spotsLayer = null;

let mediaRecorder;
let audioChunks = [];
let recordedAudioBlob = null;
const audioToggle = document.getElementById("audio-toggle");

if (audioToggle) {
    audioToggle.addEventListener("click", async () => {
        if (!mediaRecorder || mediaRecorder.state === "inactive") {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];
                mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
                mediaRecorder.onstop = () => {
                    recordedAudioBlob = new Blob(audioChunks, { type: "audio/webm" });
                    document.getElementById("audioPlayback").src = URL.createObjectURL(recordedAudioBlob);
                };
                mediaRecorder.start();
                audioToggle.classList.add("recording");
                audioToggle.style.backgroundColor = "red";
            } catch (e) { alert("Mic Error: " + e.message); }
        } else {
            mediaRecorder.stop();
            audioToggle.classList.remove("recording");
            audioToggle.style.backgroundColor = "";
        }
    });
}

document.getElementById("spot-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    
    try {
        const name = form.name.value;
        const desc = form.description.value;
        const imageFile = document.getElementById("image-upload").files[0];

        document.getElementById("status").textContent = "Saving to disk...";

        await saveSpot({
            name, description: desc,
            latitude: window.currLat, longitude: window.currLng,
            birds: form.birds.value
        }, imageFile, recordedAudioBlob);

        alert("Spot Saved Locally!");
        form.reset();
        document.getElementById("popup-form").style.display = "none";
        document.getElementById("status").textContent = "";
        recordedAudioBlob = null;
        document.getElementById("audioPlayback").src = "";
        displaySpots(); 
    } catch (err) {
        alert("Error (Did you select a folder?): " + err.message);
    }
};

export function displaySpots() {
    if (spotsLayer) window.map.removeLayer(spotsLayer);
    spotsLayer = L.layerGroup().addTo(window.map);
    
    const spots = getSpots();
    if (!spots) return;

    spots.forEach(spot => {
        if (spot.latitude == null || spot.longitude == null) {
            console.warn("Skipping invalid spot:", spot);
            return; 
        }

        const marker = L.circleMarker([spot.latitude, spot.longitude], { 
            color: '#000', 
            fillColor: '#3388ff', 
            fillOpacity: 0.8,
            radius: 10,
            weight: 1
        }).addTo(spotsLayer);

        marker.on('click', () => showSpotDetails(spot));
    });
}

async function showSpotDetails(spot) {
    const menu = document.getElementById("spot-details-menu");
    const content = document.getElementById("spot-details-content");
    const obsDate = new Date(spot.timestamp || Date.now()).toLocaleString();

    const allExternal = getExternalFiles();
    const externalFiles = allExternal.filter(f => 
        f.linked_spots && f.linked_spots.includes(spot.spotId)
    );
    const hasExternalData = externalFiles.length > 0;

    content.innerHTML = `
        <h2 id="spot-name">${spot.name}</h2>
        <p><span id="spot-coordinates">(${spot.latitude.toFixed(5)}, ${spot.longitude.toFixed(5)})</span></p>
        
        <button id="show-external-data-btn" class="show-external-data-btn" ${!hasExternalData ? "disabled" : ""}>
            Show External Media (${externalFiles.length})
        </button>
        <hr>
        <div class="spot-entry">
            <p><small><strong>Recorded:</strong> ${obsDate}</small></p>
            <p><strong>Description:</strong> ${spot.description || "No notes"}</p>
            <p><strong>Birds:</strong> ${spot.birds || "None listed"}</p>
            
            <div id="media-container-img" style="margin-top:10px;"></div>
            <div id="media-container-audio" style="margin-top:10px;"></div>
        </div>
    `;

    menu.classList.add("open");

    if (hasExternalData) {
        document.getElementById("show-external-data-btn").addEventListener("click", () => {
            openExternalViewer(externalFiles);
        });
    }

    const imgContainer = document.getElementById("media-container-img");
    if (spot.image_local_filename) {
        const url = await getLocalFileUrl(spot.image_local_filename);
        if(url) imgContainer.innerHTML = `<img src="${url}" style="max-width:100%; border-radius:8px;">`;
        else imgContainer.innerHTML = `<p style="font-size:0.8rem; color:red;">Image file missing from disk</p>`;
    }

    const audioContainer = document.getElementById("media-container-audio");
    if (spot.audio_local_filename) {
        const url = await getLocalFileUrl(spot.audio_local_filename);
        if(url) audioContainer.innerHTML = `<audio controls src="${url}" style="width:100%;"></audio>`;
    }
}

function openExternalViewer(files) {
    const viewer = document.getElementById("external-data-viewer");
    const dataContent = document.getElementById("external-data-content");
    
    let html = "";
    files.forEach(f => {
        html += `
            <div style="padding: 10px; border-bottom: 1px solid #eee;">
                <div style="font-weight:bold;">${f.name}</div>
                <div style="font-size:0.85rem; color:#666;">Type: ${f.type}</div>
            </div>
        `;
    });

    dataContent.innerHTML = html;
    viewer.style.display = "flex";
}

export function clearSpotsLayer() {
    if (spotsLayer) {
        spotsLayer.clearLayers();
    }
}

// Add listener
window.addEventListener('project-changed', () => {
    clearSpotsLayer();
    displaySpots(); // This will now fetch from the NEW active project
    // Also clear spot details panel if open
    document.getElementById("spot-details-menu").classList.remove("open");
});

document.getElementById('display-spots').addEventListener('change', (e) => {
    if(e.target.checked) displaySpots();
    else if(spotsLayer) window.map.removeLayer(spotsLayer);
});

document.getElementById("close-spot-details").addEventListener("click", () => {
    document.getElementById("spot-details-menu").classList.remove("open");
});

document.getElementById("close-external-viewer").addEventListener("click", () => {
    document.getElementById("external-data-viewer").style.display = "none";
});

window.addEventListener('data-updated', () => {
    if(document.getElementById('display-spots').checked) displaySpots();
});
window.addEventListener('storage-ready', () => {
    if(document.getElementById('display-spots').checked) displaySpots();
});