#!/usr/bin/env node
// Simple RTDB fetcher: usage
//   node tools/fetch_rtdb.js <url>
// or set env DB_URL or FIREBASE_DATABASE_URL
const urlArg = process.argv[2] || process.env.DB_URL || process.env.FIREBASE_DATABASE_URL
if (!urlArg) {
  console.error('Usage: node tools/fetch_rtdb.js <RTDB_URL>')
  console.error('Example: node tools/fetch_rtdb.js https://farmora-3d65b-default-rtdb.firebaseio.com/farms/thabo-farm.json')
  process.exit(1)
}

let url = urlArg
if (!url.endsWith('.json')) {
  // normalize
  url = url.replace(/\/$/, '') + '.json'
}

console.log('Fetching', url)

(async () => {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const data = await res.json()
    console.log(JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('Error fetching RTDB:', err.message)
    process.exit(2)
  }
})()
