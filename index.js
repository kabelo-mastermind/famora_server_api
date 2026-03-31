import express from 'express'
import admin from 'firebase-admin'
import cors from 'cors'
import dotenv from 'dotenv'
import crypto from 'crypto'

dotenv.config()

const app = express()

// CORS: allow the frontend and localhost dev origins; permit tools (no origin)
const allowedOrigins = [
  'https://farmora-two.vercel.app',
  'http://localhost:5174',
  'http://localhost:5173',
]
const normalize = (u) => (u || '').replace(/\/$/, '')
const allowed = new Set(allowedOrigins.map(normalize))

app.use(cors({
  origin(origin, callback) {
    // allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return callback(null, true)
    if (allowed.has(normalize(origin))) return callback(null, true)
    return callback(new Error('CORS policy: origin not allowed'), false)
  },
  credentials: true,
}))
app.use(express.json())

// Initialize Firebase Admin
// Support multiple deployment patterns:
// 1) FIREBASE_SERVICE_ACCOUNT: JSON string of the service account (not recommended for easy typing)
// 2) FIREBASE_SERVICE_ACCOUNT_B64: base64-encoded JSON (recommended for env values)
// 3) GOOGLE_APPLICATION_CREDENTIALS: path to service account JSON on filesystem (local dev)
let initialized = false
let serviceAccount = null
if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
  try {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    serviceAccount = JSON.parse(decoded)
  } catch (err) {
    console.error('Invalid FIREBASE_SERVICE_ACCOUNT_B64:', err.message)
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  } catch (err) {
    console.error('Invalid FIREBASE_SERVICE_ACCOUNT JSON:', err.message)
  }
}

if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
      databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${serviceAccount.project_id}.firebaseio.com`,
    })
    console.log('Firebase Admin initialized from service account env')
    initialized = true
  } catch (err) {
    console.error('Failed to initialize Firebase Admin from service account:', err.message)
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    admin.initializeApp({
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    })
    console.log('Firebase Admin initialized from GOOGLE_APPLICATION_CREDENTIALS (with databaseURL)')
    initialized = true
  } catch (err) {
    console.error('Failed to initialize Firebase Admin from GOOGLE_APPLICATION_CREDENTIALS:', err.message)
  }
}

if (!initialized) {
  console.error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_B64, FIREBASE_SERVICE_ACCOUNT, or GOOGLE_APPLICATION_CREDENTIALS.')
}

const db = admin.app ? admin.firestore() : null
const rdb = admin.app ? admin.database() : null

// Simulation: when enabled, periodically write fake sensor data into each user's `data` collection
if (process.env.ENABLE_SIMULATION === 'true' && (db || rdb)) {
  const intervalMs = parseInt(process.env.SIM_INTERVAL_MS || '15000', 10)
  console.log('Simulation enabled: writing fake sensor data every', intervalMs, 'ms')

  const sampleSensorPayload = () => ({
    temperature: +(20 + Math.random() * 10).toFixed(2),
    humidity: +(30 + Math.random() * 50).toFixed(2),
    soilMoisture: +(10 + Math.random() * 80).toFixed(2),
    light: +(200 + Math.random() * 800).toFixed(0),
  })

  setInterval(async () => {
    try {
      // enumerate users: prefer RTDB if available
      let userIds = []
      if (rdb) {
        const snap = await rdb.ref('users').once('value')
        const val = snap.val() || {}
        userIds = Object.keys(val)
      } else {
        const usersSnap = await db.collection('users').get()
        userIds = usersSnap.docs.map((d) => d.id)
      }

      for (const uid of userIds) {
        if (rdb) {
          await rdb.ref(`users/${uid}/data`).push({
            payload: sampleSensorPayload(),
            receivedAt: admin.database.ServerValue.TIMESTAMP,
          })
        } else {
          const timestamp = admin.firestore.FieldValue.serverTimestamp()
          await db.collection('users').doc(uid).collection('data').add({
            payload: sampleSensorPayload(),
            receivedAt: timestamp,
          })
        }
      }
    } catch (err) {
      console.error('Simulation error:', err.message)
    }
  }, intervalMs)
}

async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || ''
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' })
  const idToken = authHeader.split('Bearer ')[1].trim()
  try {
    const decoded = await admin.auth().verifyIdToken(idToken)
    req.user = decoded
    next()
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized', details: err.message })
  }
}

app.get('/api/ping', (req, res) => res.json({ ok: true }))

app.get('/api/data', verifyToken, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firestore not initialized' })
  try {
    const snapshot = await db.collection('users').doc(req.user.uid).collection('data').get()
    const items = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))
    res.json({ data: items })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/data', verifyToken, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firestore not initialized' })
  try {
    const payload = req.body
    const docRef = await db.collection('users').doc(req.user.uid).collection('data').add({
      ...payload,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    res.json({ id: docRef.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// (Gadget-specific routes removed) Use public sensor ingestion and authenticated `/api/data` for storage/retrieval.

// Public sensor ingestion endpoint
// Sensors can POST JSON payloads here. To prevent abuse, set `SENSOR_API_KEY` in env
// and include it in the request header `x-sensor-key` or query `?key=`.
// Sensor auth middleware: supports either a shared API key (`SENSOR_API_KEY`) sent
// in header `x-sensor-key` (or query `?key=`), or an HMAC signature using
// `SENSOR_SECRET` in header `x-signature` (format: `sha256=<hex>`).
function verifySensorAuth(req, res, next) {
  if (!rdb) return res.status(500).json({ error: 'Realtime Database not initialized' })

  // 1) API key check
  const expectedKey = process.env.SENSOR_API_KEY
  if (expectedKey) {
    const provided = req.headers['x-sensor-key'] || req.query.key
    if (provided && provided === expectedKey) return next()
  }

  // 2) HMAC signature check
  const secret = process.env.SENSOR_SECRET
  if (secret) {
    const sig = req.headers['x-signature'] || ''
    const payloadStr = JSON.stringify(req.body || {})
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payloadStr).digest('hex')
    try {
      const a = Buffer.from(sig)
      const b = Buffer.from(expected)
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next()
    } catch (e) {
      // ignore and fall through to unauthorized
    }
  }

  return res.status(401).json({ error: 'Invalid sensor authentication' })
}

app.post('/api/sensors/data', verifySensorAuth, async (req, res) => {
  const { ownerUid, sensorId, payload } = req.body || {}
  if (!ownerUid || !payload) return res.status(400).json({ error: 'Missing ownerUid or payload in body' })

  try {
    const ref = rdb.ref(`users/${ownerUid}/data`)
    const newRef = await ref.push({
      sensorId: sensorId || null,
      payload,
      receivedAt: admin.database.ServerValue.TIMESTAMP,
    })
    res.json({ id: newRef.key })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Authenticated endpoint to read realtime data for the signed-in user
app.get('/api/sensors/data', verifyToken, async (req, res) => {
  if (!rdb) return res.status(500).json({ error: 'Realtime Database not initialized' })
  try {
    const snap = await rdb.ref(`users/${req.user.uid}/data`).once('value')
    const val = snap.val() || {}
    const items = Object.entries(val).map(([id, v]) => ({ id, ...v }))
    res.json({ data: items })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Tool route: fetch an RTDB path and return its JSON. Example:
// GET /tools/fetch?path=/farms/thabo-farm
app.get('/tools/fetch', async (req, res) => {
  if (!rdb) return res.status(500).json({ error: 'Realtime Database not initialized' })
  const raw = req.query.path || req.query.p
  if (!raw) return res.status(400).json({ error: 'Missing `path` query parameter' })
  // normalize path: strip leading slash
  const path = String(raw).replace(/^\/*/, '')
  try {
    const snap = await rdb.ref(path).once('value')
    const val = snap.val()
    return res.json({ path: `/${path}`, data: val })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

const port = process.env.PORT || 4000
app.listen(port, () => console.log(`famora_server_api listening on ${port}`))
