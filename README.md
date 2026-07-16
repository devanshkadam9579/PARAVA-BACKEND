# PARAVA Celebrations - Backend Web Service

This is the Node.js Express backend server for PARVA Celebrations, integrated with Razorpay payments and Firebase Firestore.

## 🚀 Local Development

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Environment Setup**:
   Create a `.env` file in the root directory:
   ```env
   PORT=5000
   RAZORPAY_KEY_ID=rzp_test_TE7IEPsVrpMrj7
   RAZORPAY_KEY_SECRET=BTTxm1K1lZj7VeTKlDdYYeYO
   ```

3. **Start the Server**:
   ```bash
   npm start
   ```
   The backend will be available at `http://localhost:5000`.

---

## ☁️ Deployment on Render

To deploy this backend as a **Web Service** on [Render](https://render.com/):

### Step 1: Push code to GitHub
Make sure all changes are committed and pushed to your backend repository:
```bash
git add .
git commit -m "Initialize backend repository"
git branch -M main
git push -u origin main
```

### Step 2: Create a Web Service on Render
1. Go to your **Render Dashboard** and click **New > Web Service**.
2. Connect your GitHub account and select the **PARAVA-BACKEND** repository.
3. Configure the following settings:
   - **Name**: `parava-backend`
   - **Environment**: `Node`
   - **Region**: Select the region closest to your users (e.g. `Singapore` or `Oregon`)
   - **Branch**: `main`
   - **Root Directory**: Leave blank (root of repository)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free` (or any paid tier)

### Step 3: Add Environment Variables
Under the **Environment** tab, add the following variables:
- `RAZORPAY_KEY_ID`: `rzp_test_TE7IEPsVrpMrj7`
- `RAZORPAY_KEY_SECRET`: `BTTxm1K1lZj7VeTKlDdYYeYO`
- `NODE_ENV`: `production`

Click **Create Web Service** to start the deployment. Once done, Render will provide you with a live URL (e.g., `https://parava-backend.onrender.com`).
