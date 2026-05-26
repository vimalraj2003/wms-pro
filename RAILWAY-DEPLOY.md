# Deploy WMS Pro to Railway (Free + Permanent Database)

## Step 1 — Create GitHub Account
Go to https://github.com and sign up (free)

## Step 2 — Create New Repository
1. Click + → New repository
2. Name: wms-pro  |  Set to Private
3. Click "Create repository"
4. Click "uploading an existing file"
5. Drag ALL files from this zip (keep folder structure)
6. Click "Commit changes"

## Step 3 — Create Railway Account
Go to https://railway.app → Sign up with GitHub (free)

## Step 4 — Create Project on Railway
1. Click "New Project"
2. Click "Deploy from GitHub repo"
3. Select your wms-pro repository
4. Click "Deploy Now"

## Step 5 — Add FREE PostgreSQL Database
1. In your Railway project, click "+ New"
2. Click "Database" → "Add PostgreSQL"
3. Railway automatically connects it! DATABASE_URL is set automatically.

## Step 6 — Get Your Live URL
1. Click your service → Settings → Networking
2. Click "Generate Domain"
3. Your WMS is live at: https://wms-pro-xxxx.up.railway.app

## Login
- Email: admin@wms.com
- Password: admin123

## Notes
- Data is permanently saved in PostgreSQL — never resets!
- Railway free tier: 500 hours/month + 1GB PostgreSQL (free)
- To add AI assistant: go to Railway → Variables → add ANTHROPIC_API_KEY

