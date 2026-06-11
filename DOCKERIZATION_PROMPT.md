# Prompt — Containerize the CEM field-ecology web app for the lab cluster

## 0. How to read this brief

You are an AI coding agent. Your job is to make this web application run as a
container inside the lab's docker-based cluster, exactly the way the professor
described it in the project meeting.

This document deliberately specifies **what** the result must be and **why** —
the requirements, constraints, and intent. It does **not** prescribe **how** to
achieve them. Choosing base images, build tooling, orchestration mechanics, mount
syntax, proxy configuration, and similar implementation details is your job (in
consultation with the infra leads). Where the professor named a specific tool
(NGINX, Airflow, STAC, the file browser, Google Drive), treat the tool as a fixed
requirement but the way you wire it up as open.

Several details in the source meeting were incomplete. Anything you cannot
confirm from the codebase is collected in **Section 8 (Open questions)** — surface
those and get answers rather than guessing.

Do not make application code changes as part of understanding this brief; first
produce a containerization plan that satisfies every requirement below.

---

## 1. The bigger picture this app must fit into

The app is **not** a standalone deployment. It is one application inside a larger,
evolving compute platform. The container you produce has to behave like a good
citizen of that platform.

- **One physical node today, a cluster tomorrow.** Right now everything runs on a
  single physical node. The design must not assume that stays true: eventually
  there will be many nodes behind **one entry point**, with a scheduler
  (Kubernetes is being explored by another group) deciding which node actually
  runs a given workload. Do not hardcode anything that assumes a single machine.
- **One web server on the node; everything else is its own container.** Each
  service — geospatial server, catalog service, orchestrator, file browser, and
  the compute apps — runs as a separate docker.
- **A central orchestrator (Apache Airflow) runs all heavy compute.** Airflow
  hosts pipelines (DAGs, defined in YAML) that can be triggered to run work and to
  call APIs on the compute services. The hard rule: **every resource-consuming
  computation must be dispatched through Airflow** — either triggered directly in
  Airflow or channelled via an API/CLI that Airflow exposes — so that, later, the
  cluster scheduler can place that work on whichever node is appropriate. Compute
  must never run "directly" inside a web request in a way that bypasses Airflow.
- **A catalog of results (STAC).** Outputs produced by compute services are
  registered as STAC items — small JSON metadata records describing geo-located
  assets — so the platform keeps the provenance/history of every output (which
  algorithm version and which input parameters produced it). This catalog is
  referred to in the meeting as "STAC-B" / "stack B".
- **A single entry point (NGINX) routes by URL.** All services sit behind one
  reverse proxy that dispatches by URL path to the correct container. All
  containers share a common network and must be reachable from one another **by
  name**.
- **A shared file browser** exposes the data directories to users (browse,
  download, share, and in limited cases edit files) with read-only / read-write
  access control and time-limited public share links.

Adjacent compute apps (a "code-stack" service and a "drone" service) already
follow this pattern; this app is to follow the **same** pattern.

---

## 2. What this app is, and the role its container plays

This app is the **field-ecology data app** (spots, photos, audio, longitudinal
tree/bioacoustic monitoring). Today it is a static front end that stores data in a
user-selected local folder and syncs metadata to Google Drive, and it runs
analysis **locally** through a "watcher" helper that fetches analysis scripts from
GitHub and executes them on the user's machine.

We are now adding a **"run on the cluster"** capability alongside the existing
local mode. The containerization work is the **cluster side** of that capability.
Concretely, the app's presence in the cluster must be able to:

1. **Serve its own front end** on the node (reached through the proxy).
2. **Accept uploaded bulk field data** (audio, images, etc.) into shared storage.
3. **Trigger compute** for the uploaded data — through Airflow.
4. **Write outputs** to the shared data directory.
5. **Register STAC items** for those outputs.
6. Let the user **browse/download** their cluster-side data via the file browser.

The existing **local** workflow (watcher + local folder + Drive sync) must keep
working unchanged. Cluster mode is an **added option (a toggle)**, not a
replacement.

---

## 3. The professor's hard container conventions

These are the load-bearing requirements. They apply to this app's container(s) the
same way they apply to every other service in the platform.

### 3.1 The application code lives OUTSIDE the image and is mounted in

- The image must contain **only the environment** the app needs to run: language
  runtime, libraries/dependencies, any database, and any external applications or
  binaries.
- The **application source code must not be baked into the image.** It is provided
  to the container from outside (mounted in) so that the running code can be
  updated in place, on production, **without rebuilding or re-pulling the image.**
- Therefore: a **pure code change or bug fix must not require an image rebuild.**
  An image rebuild is required **only** when dependencies change — a new library, a
  new system package, a new external application.
- The image build must be tied to the development process so that dependency
  changes and image rebuilds stay in sync. A standalone, hand-built image that
  someone later pulls and that then breaks is exactly what to avoid. Provide a
  **documented, repeatable, ideally automated** build-and-update process (a
  standard "recipe" for creating/updating this kind of container, stating clearly
  what gets installed). Library/dependency updates must be linked to this process.

### 3.2 All data lives OUTSIDE the image, on a shared deployment directory

- **Every input and output directory lives outside the code repository and outside
  the image**, supplied to the container as a mounted volume.
- There is **one common "deployment" directory** — a shared disk or common data
  directory on the host — with a **sub-directory per application** (the meeting
  named sibling folders such as the code-stack folder, a "factory" folder, and a
  drone folder). **Each container mounts only its own sub-directory** for its work.
- Mental model the professor gave: treat the data directory as a disk that
  physically lives on another machine and is mounted into the container. **The
  platform owns the data; the container is just compute over it.**
- The output directory this app writes to must be the **same directory the file
  browser exposes**, so users can browse and download results without any extra
  copy step.

### 3.3 Paths are configuration, never hardcoded

- The app must read **all input/output locations from a config file.** It must not
  assume data sits inside the repo, and it must not hardcode any path. Moving from
  local to cluster (where mount points differ) should be **only a config change.**
- The **folder structure used locally for bulk data and the folder structure in
  the cluster data directory must match**, so the same analysis scripts run
  identically in both places.

### 3.4 Networking and the single entry point

- The container joins the **shared docker network** and is **reachable by service
  name** from the other containers.
- The app is exposed to the outside **only through the NGINX entry point**, at a
  **URL path** (for example `/<app>` — see open questions for the exact path).
  NGINX serves/proxies **this app's own front end and web server**, not the
  orchestrator's UI.
- **NGINX must forward the correct headers** (especially authentication/login
  headers). The meeting explicitly called out that the file browser's login broke
  because headers were not forwarded through the proxy — do not reproduce that
  class of bug.
- The front end's data and upload calls go to **this app's own API**; its compute
  actions go to **Airflow** (see Section 4).

### 3.5 Ports

- Distinguish **internal** (in-container) ports from **external** (host) ports.
  **External ports must be unique across the node** (and across nodes).
- Maintain a **central, single place that maps external ports** to services, so
  there are no collisions as services are added.

---

## 4. How this app integrates with the cluster (behavioral requirements)

### 4.1 Local vs cluster toggle

- Keep the existing **local** analysis path (watcher + local folder) intact.
- Add a **"ship to cluster"** option. Selecting it routes upload + compute to the
  cluster instead of the local watcher. Both paths must coexist.

### 4.2 Upload of bulk data

- Expose an **upload capability** (the meeting described it as ordinary HTTP
  multipart posts) that receives bulk field data and **writes it into this app's
  data sub-directory, replicating the same folder layout used locally.**
- **Bulk data lives on the cluster only.** It is not continuously re-uploaded, and
  the cluster is used for compute over it — not as the user's primary store.
- Treat **upload as a separable concern.** The professor noted the repo really has
  two roles — the app's own logic, and the job of *exposing upload APIs* — and
  suggested these can be **segregated** (potentially a separate container/service
  for upload, distinct from the compute APIs). Design so this separation is
  possible.

### 4.3 Compute is dispatched through Airflow

- A compute request must be **handed off to Airflow (a DAG)** rather than executed
  inline in the web request. Parameters (which analysis script, the inputs, the
  project id, and so on) are passed along.
- The professor described **two acceptable wiring patterns** (the choice is for the
  implementer/leads, not fixed here):
  1. The front end triggers the catalog/orchestrator layer, which in turn calls
     this app's compute API; or
  2. The front end calls this app's API, which in turn calls Airflow, which
     dispatches the compute.
  Either way, **the heavy compute is dispatched by Airflow**, so load distribution
  across nodes can be handled centrally.

### 4.4 Outputs and STAC provenance

- Compute **writes its outputs into the shared data directory** (the same one the
  file browser exposes).
- **Every output result registers a STAC item** — a small JSON metadata record. The
  platform assumes the data is geo-located (analysis is anchored to "spots", which
  carry coordinates), so the STAC item records the spot/location for the output.
  Non-spatial outputs (e.g. a CSV of species/labels) still get a STAC item that
  *describes* them with location metadata, so they appear in the catalog like any
  other item.
- **Provenance is the point:** APIs/algorithms are **versioned**, and **all input
  parameters** (algorithm parameters, model used, etc.) are recorded with the
  output so results are reproducible and traceable. Analysis parameters must be
  **shipped as inputs** so the catalog captures them — not left implicit.
- Give the user a **file-browser link** to their outputs. Access is generally
  **read-only**, with **edit access granted only to specific files** where the
  workflow needs it (for example, a generated CSV the user edits to assign cluster
  labels before the next compute step).

### 4.5 Data lifecycle / retention

- The cluster is a **compute service, not durable storage.** Generated outputs are
  **cleaned up after a retention window** (the professor mentioned roughly two
  weeks); some inputs (e.g. the orthomosaic, in the drone case) may be archived.
  Treat retention as a **configurable policy**, not a hardcoded constant.

---

## 5. Explicitly deferred (but must remain compatible)

- **Authentication / user permissions.** For now, allow open access (anyone can
  use it). But **do not build a bespoke per-app permission system.** The intended
  direction is **centralized user management / single sign-on** with tokens, where
  having access to a given Airflow DAG *is* the permission to invoke that compute.
  Design so this can slot in later without rework.
- **Kubernetes / multi-node load balancing.** Single node for now. Just keep the
  "all compute via Airflow" and "no single-node assumptions" rules so the move to
  many nodes is not blocked.

---

## 6. Acceptance criteria — what "containerized the professor's way" means

The work is complete when all of the following are demonstrably true:

- The app's **code is mounted from outside** the image and can be updated in place;
  a bug-fix-only change requires **no image rebuild or re-pull**.
- An image rebuild is needed **only** when dependencies change, and there is a
  **documented, repeatable build/update process** describing what gets installed.
- **All input/output directories are externally mounted** under the common
  deployment directory, with this app using **its own sub-directory**.
- The app **reads every path from config**; switching local↔cluster is a config
  change only, and the **local and cluster folder layouts match**.
- The container **joins the shared network**, is **reachable by name**, and is
  exposed **only via the NGINX path**, with **auth headers correctly forwarded**.
- The app's **external port is unique** and **registered in the central port map.**
- The **front end is served** through the proxy.
- **Upload** writes bulk data into the data directory in the **same layout as
  local**, and upload is **architecturally separable** from the compute APIs.
- **Compute is dispatched via Airflow**, with analysis **parameters passed as
  inputs.**
- **Outputs land in the shared directory** and are **visible/downloadable via the
  file browser**, with read-only-by-default and targeted edit access.
- **Each output registers a STAC item** carrying versioned algorithm + parameter
  provenance and location metadata.
- The **existing local (watcher) workflow still works** end to end.

---

## 7. Out of scope for this task

- No changes to the app's scientific/analysis logic.
- No building of the Kubernetes/multi-node layer.
- No bespoke auth system.
- No prescribing of specific implementation mechanics in this brief — propose them
  in your plan.

---

## 8. Open questions to confirm before/while implementing

The source meeting transcript was partial. Confirm these with the team:

1. **Deployment directory base path** and the exact **sub-folder name** this app
   should own under it.
2. **Upload placement:** its own container/service, or part of this app's
   container?
3. **Airflow trigger pattern:** which of the two wiring patterns in §4.3 is
   preferred?
4. **NGINX route** for this app (e.g. `/biomon`, `/bioacoustics`, or other).
5. **Front end hosting:** served by the same container as the APIs, or a separate
   one?
6. **Retention policy:** exact window, and precisely which inputs/outputs are
   archived vs cleaned.
7. **STAC item shape** the catalog ("STAC-B") expects for **non-spatial** outputs
   (e.g. CSVs) — is a minimal/"dummy" spec acceptable, and what fields are
   mandatory?
8. **Database requirement:** does this app's container need its own database
   (as some services do), or is it stateless over the mounted data directory?
9. **GitHub-fetched analysis scripts:** in cluster mode, are scripts still fetched
   from GitHub at run time, or baked/mounted differently?
