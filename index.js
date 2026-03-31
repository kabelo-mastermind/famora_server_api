import express from 'express'
import admin from 'firebase-admin'
import cors from 'cors'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
app.use(cors())
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
    })
    console.log('Firebase Admin initialized from service account env')
    initialized = true
  } catch (err) {
    console.error('Failed to initialize Firebase Admin from service account:', err.message)
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    admin.initializeApp()
    console.log('Firebase Admin initialized from GOOGLE_APPLICATION_CREDENTIALS')
    initialized = true
  } catch (err) {
    console.error('Failed to initialize Firebase Admin from GOOGLE_APPLICATION_CREDENTIALS:', err.message)
  }
}

if (!initialized) {
  console.error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT_B64, FIREBASE_SERVICE_ACCOUNT, or GOOGLE_APPLICATION_CREDENTIALS.')
}

const db = admin.app ? admin.firestore() : null

// Simulation: when enabled, periodically write fake sensor data into each user's `data` collection
if (process.env.ENABLE_SIMULATION === 'true' && db) {
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
      const usersSnap = await db.collection('users').get()
      const timestamp = admin.firestore.FieldValue.serverTimestamp()
      for (const u of usersSnap.docs) {
        await db.collection('users').doc(u.id).collection('data').add({
          payload: sampleSensorPayload(),
          receivedAt: timestamp,
        })
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
app.post('/api/sensors/data', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firestore not initialized' })

  const expectedKey = process.env.SENSOR_API_KEY
  if (expectedKey) {
    const provided = req.headers['x-sensor-key'] || req.query.key
    if (!provided || provided !== expectedKey) return res.status(401).json({ error: 'Invalid sensor API key' })
  }

  const { ownerUid, sensorId, payload } = req.body || {}
  if (!ownerUid || !payload) return res.status(400).json({ error: 'Missing ownerUid or payload in body' })

  try {
    const docRef = await db.collection('users').doc(ownerUid).collection('data').add({
      sensorId: sensorId || null,
      payload,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    res.json({ id: docRef.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const port = process.env.PORT || 4000
app.listen(port, () => console.log(`famora_server_api listening on ${port}`))
