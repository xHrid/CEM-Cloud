import { saveSite } from './storage.js';

const form = document.getElementById("add-site-form");

form.onsubmit = async (e) => {
    e.preventDefault();
    const name = form.siteName.value;
    const file = document.getElementById("kml-upload").files[0];

    document.getElementById("add-site-status").textContent = "Uploading to Drive...";

    try {
        await saveSite(name, file);
        alert("Site KML Saved to Drive!");
        document.getElementById("add-site-popup-form").style.display = "none";
        form.reset();
        document.getElementById("add-site-status").textContent = "";
    } catch (err) {
        alert("Error: " + err.message);
    }
};