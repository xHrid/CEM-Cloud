import time
import json
import os
import sys
import shutil
import subprocess
import urllib.request
from pathlib import Path
from datetime import datetime

# --- CONFIGURATION ---
WATCH_INTERVAL = 2
HEARTBEAT_FILE = "system/status.json"
SCRIPTS_DIR = "system/scripts"
INSTALLED_REGISTRY = "system/scripts/installed.json"

# [CHANGED] Pointed to the ROOT of the repository
GITHUB_REPO_URL = "https://raw.githubusercontent.com/xHrid/cem-scripts/refs/heads/main" 

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def update_heartbeat(root_path):
    """Writes status to the ROOT system folder."""
    status_path = root_path / HEARTBEAT_FILE
    status_path.parent.mkdir(parents=True, exist_ok=True)
    
    data = {
        "status": "online",
        "last_active_ts": datetime.now().isoformat(),
        "worker_pid": os.getpid(),
        "root_path": str(root_path) 
    }
    try:
        with open(status_path, 'w') as f:
            json.dump(data, f)
    except Exception as e:
        log(f"Error updating heartbeat: {e}")

def sync_scripts(root_path):
    log("🔄 Checking for script updates from GitHub...")
    scripts_path = root_path / SCRIPTS_DIR
    scripts_path.mkdir(parents=True, exist_ok=True)
    
    try:
        # 1. Fetch the master registry from the repo root
        registry_url = f"{GITHUB_REPO_URL}/scripts.json"
        with urllib.request.urlopen(registry_url) as response:
            script_folders = json.loads(response.read().decode())
        
        installed_scripts = []
        
        # 2. Loop through each script directory declared in the registry
        for folder in script_folders:
            log(f"   📂 Syncing module: {folder}")
            manifest_url = f"{GITHUB_REPO_URL}/{folder}/manifest.json"
            
            try:
                with urllib.request.urlopen(manifest_url) as response:
                    manifest_data = json.loads(response.read().decode())
                
                for script_entry in manifest_data:
                    script_filename = script_entry['script_file']
                    local_script_path = scripts_path / script_filename
                    
                    # Download the main python script
                    if not local_script_path.exists():
                        log(f"      ⬇️ Downloading script: {script_filename}")
                        urllib.request.urlretrieve(f"{GITHUB_REPO_URL}/{folder}/{script_filename}", local_script_path)
                    
                    # Download associated assets
                    if 'assets' in script_entry:
                        for asset in script_entry['assets']:
                            local_asset_path = scripts_path / asset
                            if not local_asset_path.exists():
                                log(f"      ⬇️ Downloading asset: {asset}")
                                urllib.request.urlretrieve(f"{GITHUB_REPO_URL}/{folder}/{asset}", local_asset_path)

                    installed_scripts.append(script_entry)
            
            except Exception as folder_err:
                log(f"   ⚠️ Skipping {folder} (Manifest missing or invalid): {folder_err}")

        # 3. Save the aggregated master registry for the frontend
        with open(root_path / INSTALLED_REGISTRY, 'w') as f:
            json.dump(installed_scripts, f, indent=2)
            
        log(f"✅ Successfully synced {len(installed_scripts)} analysis scripts.")

    except Exception as e:
        log(f"⚠️ Sync failed (using cached scripts if available): {e}")


def process_job(job_file, root_path):
    job_id = job_file.stem
    log(f"⚡ Found Job: {job_id} in {job_file.parent.parent.parent.name}")

    project_root = job_file.parent.parent.parent
    
    processing_dir = project_root / "jobs/processing"
    completed_dir = project_root / "jobs/completed"
    results_dir = project_root / "jobs/results"
    failed_dir = project_root / "jobs/failed"

    for d in [processing_dir, completed_dir, results_dir, failed_dir]:
        d.mkdir(parents=True, exist_ok=True)

    processing_path = processing_dir / job_file.name
    shutil.move(str(job_file), str(processing_path))

    try:
        with open(processing_path, 'r') as f:
            job_data = json.load(f)

        script_name = job_data.get("script_name", "core_script.py")
        params = job_data.get("parameters", {})
        input_rel_paths = job_data.get("input_files", [])

        script_path = (root_path / SCRIPTS_DIR / script_name).resolve()
        if not script_path.exists():
             script_path = (root_path / script_name).resolve()

        if not script_path.exists():
            raise FileNotFoundError(f"Script not found: {script_name}")

        abs_input_files = []
        for p in input_rel_paths:
            abs_p = (root_path / p).resolve()
            if abs_p.exists():
                abs_input_files.append(str(abs_p))
            else:
                log(f"⚠️ Warning: Input file missing: {p}")

        if not abs_input_files:
            raise ValueError("No valid input files found.")

        job_result_dir = results_dir / job_id
        job_result_dir.mkdir(parents=True, exist_ok=True)
        output_csv = job_result_dir / "detections.csv"

        cmd = [sys.executable, str(script_path)]
        cmd.extend(["--input-files"] + abs_input_files)
        cmd.extend(["--output-file", str(output_csv)])
        
        if "lat" in params: cmd.extend(["--lat", str(params["lat"])])
        if "lon" in params: cmd.extend(["--lon", str(params["lon"])])
        if "min_confidence" in params: cmd.extend(["--min-confidence", str(params["min_confidence"])])
        
        noise_file = params.get("static_noise_file")
        if noise_file:
            if "spots/" in noise_file or "project_" in noise_file:
                noise_file = str((root_path / noise_file).resolve())
            cmd.extend(["--static-noise-file", noise_file])

        log(f"   Running {script_name}...")
        
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode == 0:
            log("   ✅ Success!")
            with open(job_result_dir / "stdout.log", "w") as f: f.write(result.stdout)
            shutil.move(str(processing_path), str(completed_dir / job_file.name))
        else:
            log("   ❌ Script Failed")
            with open(job_result_dir / "error.log", "w") as f: f.write(result.stderr)
            raise Exception("Script execution failed")

    except Exception as e:
        log(f"   ❌ Job Failed: {e}")
        shutil.move(str(processing_path), str(failed_dir / job_file.name))


def main():
    root_path = Path.cwd()
    log(f"--- 🔭 Global CEM Watcher Started ---")
    log(f"Root: {root_path}")
    
    sync_scripts(root_path)
    
    try:
        while True:
            update_heartbeat(root_path)
            job_files = list(root_path.glob("*/jobs/queue/*.json"))
            
            if job_files:
                job_files.sort(key=lambda f: f.stat().st_mtime)
                process_job(job_files[0], root_path)
            
            time.sleep(WATCH_INTERVAL)
            
    except KeyboardInterrupt:
        log("Stopping Watcher...")
        status_path = root_path / HEARTBEAT_FILE
        if status_path.exists():
            os.remove(status_path)

if __name__ == "__main__":
    main()