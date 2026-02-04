const map = L.map("map", { 
    minZoom: 3, 
    maxZoom: 18, 
    zoomControl: false 
}).setView([20, 0], 3); 

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

window.map = map;
window.currLat = 0;
window.currLng = 0;

map.locate({ watch: true, enableHighAccuracy: true });

map.on("locationfound", (e) => {
  window.currLat = e.latitude;
  window.currLng = e.longitude;
  
  const label = document.querySelector("#latlon label");
  if(label) label.textContent = `Lat: ${e.latitude.toFixed(5)}, Lng: ${e.longitude.toFixed(5)}`;

  if (!window.myLocationMarker) {
      window.myLocationMarker = L.circleMarker(e.latlng, { 
          radius: 8, 
          color: '#ffffff', 
          fillColor: '#2196F3', 
          fillOpacity: 1, 
          weight: 2 
      }).addTo(map).bindPopup("You are here");
  } else {
      window.myLocationMarker.setLatLng(e.latlng);
  }
});

map.on("locationerror", (e) => {
    console.warn("Location access denied or failed.", e.message);
});