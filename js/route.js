import { saveRoute } from './storage.js';

let routePoints = [];
let routePolyline = null;
let isTracking = false;

document.getElementById("toggle-tracking").addEventListener("click", (e) => {
    const btn = e.target;
    isTracking = !isTracking;
    
    if (isTracking) {
        routePoints = [];
        if(routePolyline) window.map.removeLayer(routePolyline);
        routePolyline = L.polyline([], { color: 'blue' }).addTo(window.map);
        btn.textContent = "Stop & Save";
        btn.style.background = "red";
    } else {
        btn.textContent = "Record";
        btn.style.background = "";
        document.getElementById("save-route-dialog").style.display = "block";
    }
});

window.map.on('locationfound', (e) => {
    if (!isTracking) return;
    const pt = { lat: e.latitude, lng: e.longitude };
    routePoints.push(pt);
    if(routePolyline) routePolyline.addLatLng(e.latlng);
});

document.getElementById("route-form").onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById("route-name").value;
    
    try {
        await saveRoute({ name, points: routePoints });
        alert("Route Saved to Drive!");
        document.getElementById("save-route-dialog").style.display = "none";
        routePoints = [];
    } catch (err) {
        alert("Error: " + err.message);
    }
};

document.querySelector("#save-route-dialog .close").onclick = () => {
    document.getElementById("save-route-dialog").style.display = "none";
};