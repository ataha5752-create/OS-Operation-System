# Railway Deployment Guide 🚀

This project has been prepared to run seamlessly on **Railway.app** as a cloud service. Follow this guide to set it up.

---

## 📋 Table of Contents
1. [Key Configurations Added](#1-key-configurations-added)
2. [Prerequisites](#2-prerequisites)
3. [Step-by-Step Deployment](#3-step-by-step-deployment)
4. [Setting up Environment Variables](#4-setting-up-environment-variables)
5. [Configuring Persistent Volume (Critical for SQLite Database & Uploads)](#5-configuring-persistent-volume-critical-for-sqlite-database--uploads)

---

## 1. Key Configurations Added

To make the app run on Railway, we updated the configuration:
* **Conditional SSL**: The app detects `DISABLE_SSL=true` and runs standard HTTP (Railway automatically handles public HTTPS on port `443` and routes it to port `3000`).
* **Configurable Database & Uploads Path**: Using `SQLITE_DB_PATH` and `UPLOADS_DIR` environment variables, you can store data in a persistent directory so it is not lost when the server restarts or redeploys.
* **Auto-Shutdown Disabled**: The server stays online 24/7.

---

## 2. Prerequisites
1. A **Railway** account ([railway.app](https://railway.app)).
2. A **GitHub** repository containing your source code. (You can push this entire folder to a new private GitHub repository).

---

## 3. Step-by-Step Deployment

1. **Push to GitHub**:
   Initialize git in this folder, commit your files, and push them to a private GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "Configure project for Railway deployment"
   git branch -M main
   git remote add origin <YOUR_GITHUB_REPO_URL>
   git push -u origin main
   ```

2. **Deploy on Railway**:
   * Go to [Railway Dashboard](https://railway.app/dashboard).
   * Click **+ New Project** -> **Deploy from GitHub repo**.
   * Select your repository.
   * Click **Deploy Now**.

---

## 4. Setting up Environment Variables

Once the project starts deploying, click on your service in Railway, go to the **Variables** tab, and add the following variables:

| Variable Name | Value | Description |
| :--- | :--- | :--- |
| `DISABLE_SSL` | `true` | **(Required)** Tells Node.js to use HTTP (Railway handles SSL termination automatically). |
| `PORT` | `3000` | The internal port Railway routing will connect to. |
| `JWT_SECRET` | `generate-some-long-random-string-here` | Secret key used for signing login tokens. |
| `SQLITE_DB_PATH` | `/data/data.db` | Path inside the persistent volume where the SQLite database file is saved. |
| `UPLOADS_DIR` | `/data/uploads` | Path inside the persistent volume where file attachments are saved. |

---

## 5. Configuring Persistent Volume (Critical!)

Railway containers have ephemeral file systems. If you redeploy or the server restarts, SQLite database changes and upload files will be lost unless you mount a **Persistent Volume**.

1. In the Railway project board, click **+ New** -> **Volume**.
2. Create a volume. Let's call it `data-volume` (Railway assigns a default size of 1GB, which is plenty).
3. Connect the Volume to your Node service:
   * Click on your Node service -> **Settings** tab.
   * Scroll down to the **Volumes** section.
   * Click **Mount Volume**.
   * Set the **Mount Path** to `/data`.
4. Redeploy your service. Now, all data saved to `/data/data.db` and `/data/uploads/` will persist forever!
