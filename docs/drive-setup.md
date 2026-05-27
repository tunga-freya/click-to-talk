# Auto-upload recordings to Google Drive (5-min setup)

The app **always** downloads the WebM locally when you stop a recording.
This guide adds **automatic Drive upload** on top of that.

Tunga, you only need to do this **once**. After that, every John Pork
recording goes straight into a Drive folder you control.

---

## What you'll do

1. Create a tiny Google Cloud project (or reuse one you have)
2. Enable the Drive API
3. Create a service account + JSON key (1 click each)
4. Share a Drive folder with the service account's email
5. Paste the JSON key + folder ID into Vercel as env vars

---

## Step-by-step

### 1. Make a Google Cloud project

- Open https://console.cloud.google.com/projectcreate
- Project name: `click-to-talk` (or whatever — doesn't matter)
- Hit **Create**, wait ~10s, switch to it from the project selector at the top.

### 2. Enable Drive API

- Open https://console.cloud.google.com/apis/library/drive.googleapis.com
- Hit the big blue **Enable** button. Wait ~5s.

### 3. Create the service account

- Open https://console.cloud.google.com/iam-admin/serviceaccounts
- Click **Create service account** at the top.
- Name: `john-pork-uploader` · Description: optional · **Create and continue**.
- Skip the optional roles step — just click **Done**.

### 4. Generate the JSON key

- You'll see your new service account in the list. Click on its name.
- Go to the **Keys** tab.
- **Add key → Create new key → JSON → Create**.
- A JSON file will download. Open it in a text editor — you'll paste this
  whole thing into Vercel in step 6. Keep the file open.

### 5. Share a Drive folder with the service account

- In Google Drive, create a folder — e.g. `click-to-talk recordings`.
- Right-click → **Share** → paste the service account's email
  (it looks like `john-pork-uploader@click-to-talk-xxxxx.iam.gserviceaccount.com`,
  visible in the IAM page from step 3).
- Give it **Editor** access. **Send**.
- Now copy the folder ID from the URL —
  `https://drive.google.com/drive/folders/THIS_LONG_STRING_IS_THE_ID`.

### 6. Add env vars to Vercel

Two ways:

**A. Vercel dashboard (visual)**

- Open https://vercel.com/tunga-2184s-projects/click-to-talk/settings/environment-variables
- Add two variables (all environments):
  - `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the ENTIRE JSON file contents from step 4
  - `GOOGLE_DRIVE_FOLDER_ID` — paste the folder ID from step 5
- Hit Save.

**B. CLI (faster)**

```bash
cd ~/Desktop/claude-temp/click-to-talk
cat /path/to/downloaded-key.json | vercel env add GOOGLE_SERVICE_ACCOUNT_JSON production
echo "YOUR_FOLDER_ID" | vercel env add GOOGLE_DRIVE_FOLDER_ID production
vercel deploy --prod --yes
```

### 7. Verify

- Open https://click-to-talk.vercel.app
- Click **Summon John Pork** → pick a screen / tab to share → talk for a few seconds → click again to stop.
- A WebM downloads locally **AND** a copy appears in your Drive folder.
- Browser console will log `Drive URL: https://drive.google.com/file/...` for confirmation.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Recording downloads but nothing in Drive | Env vars not set, or service account doesn't have access to the folder. Re-do step 5. |
| `403 storageQuotaExceeded` in browser console | Service accounts have 0 storage of their own — the file MUST go into a folder owned by your personal Drive account. Check that the folder ID is one *you* own, then re-share with the service account. |
| `401 unauthorized` | The JSON key is malformed (line breaks lost during paste). Re-paste it as a single var value. |
| `Drive resumable init failed` 404 | Wrong folder ID. Re-copy from the URL. |
| Recording is huge (> 100 MB) | Lower the framerate cap further in `src/recording.ts` (`max: 15` → `max: 8`). |

---

## Why a service account (and not OAuth)?

- Zero per-user login. The server uses ONE identity, always available.
- Recording happens in browser, uploads via a resumable URL → no Vercel 4.5 MB
  body limit, no proxying of large blobs through your serverless function.
- Drawback: files in your Drive folder are owned by the service account
  (you can't delete them from the Drive web UI without admin rights).
  → easy fix: in step 4's JSON, add `"supports_team_drives": true`
  AND use a Shared Drive instead of a personal folder. Then ownership lives
  on the Shared Drive itself.
