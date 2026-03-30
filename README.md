Setup

1. Create a Firebase project and enable Authentication (e.g., Google) and Firestore.

2. For the frontend (Vite):
- Add the following environment variables in a `.env` or `.env.local` at the `farmora/` root:

VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...

Then run `npm install` in the `farmora/` folder and `npm run dev`.

3. For the backend (`famora_server_api`):
- Provide Firebase Admin credentials either by setting `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON file path, or set an environment variable `FIREBASE_SERVICE_ACCOUNT` containing the JSON string of the service account (useful for containerized deployments). Also set `FIREBASE_PROJECT_ID` if needed.

- Install dependencies and start the server:

cd famora_server_api
npm install
npm start

4. API
- `GET /api/ping` - health
- `GET /api/data` - returns authenticated user's data (requires `Authorization: Bearer <idToken>`)
- `POST /api/data` - stores data under the authenticated user

Note: gadget-specific routes were removed. Use `POST /api/sensors/data` for ingestion and `GET /api/data` for authenticated retrieval.

Simulation
- To enable server-side simulated sensor data (useful for development), set `ENABLE_SIMULATION=true` in your environment. The server will write fake sensor documents into each user's `data` subcollection at a regular interval.
- Control interval with `SIM_INTERVAL_MS` (default `15000`).

Sensors ingestion (device -> server -> Firestore)
- Endpoint: `POST /api/sensors/data` — sensors send JSON payloads with shape `{ ownerUid, sensorId, payload }`.
	- `ownerUid` (string) — UID of the Firebase user (farm owner) to attach the data to.
	- `sensorId` (optional) — device identifier.
	- `payload` (object) — arbitrary sensor readings (temperature, moisture, etc.).
- Storage: payloads are stored under `users/{ownerUid}/data` with `sensorId` and `receivedAt` timestamp.
- Security: optionally set `SENSOR_API_KEY` in `famora_server_api/.env` and include the value in the `x-sensor-key` header (or `?key=` query) when posting from devices.

Frontend retrieval
- The frontend should continue using the authenticated endpoints (`GET /api/data`) to retrieve the user's sensor documents; authentication via Firebase ID token is required for retrieval.

Notes
- The frontend will request the user's ID token and must include it in `Authorization: Bearer <token>` for calls to the backend.
- The service account must have access to Firestore.