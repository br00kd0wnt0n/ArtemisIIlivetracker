const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
});

// ─── SCHEMA ───
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        data_timestamp TEXT NOT NULL,
        x DOUBLE PRECISION NOT NULL,
        y DOUBLE PRECISION NOT NULL,
        z DOUBLE PRECISION NOT NULL,
        vx DOUBLE PRECISION NOT NULL,
        vy DOUBLE PRECISION NOT NULL,
        vz DOUBLE PRECISION NOT NULL,
        altitude_km INTEGER NOT NULL,
        speed_m_s INTEGER NOT NULL,
        range_from_earth_km INTEGER NOT NULL,
        range_from_moon_km INTEGER NOT NULL,
        source TEXT DEFAULT 'horizons',
        validated BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_telemetry_data_ts ON telemetry(data_timestamp);

      CREATE TABLE IF NOT EXISTS mission_events (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        event_type TEXT NOT NULL,
        description TEXT,
        source TEXT DEFAULT 'll2',
        raw_data JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON mission_events(timestamp DESC);
    `);
    console.log('[DB] Schema initialized');
  } catch (err) {
    console.error('[DB] Schema init failed:', err.message);
  }
}

// ─── TELEMETRY ───

async function storeTelemetry(data) {
  try {
    // Validate: reject impossible data points
    if (data.altitude_km < -100 || data.altitude_km > 500000) {
      console.log(`[DB] Rejected: altitude ${data.altitude_km} km out of range`);
      return false;
    }
    if (data.speed_m_s < 0 || data.speed_m_s > 15000) {
      console.log(`[DB] Rejected: speed ${data.speed_m_s} m/s out of range`);
      return false;
    }

    // Check for impossible jumps (> 50,000 km in under 2 minutes)
    const last = await getLatestTelemetry();
    if (last) {
      const timeDiffMs = new Date(data.timestamp).getTime() - new Date(last.data_timestamp).getTime();
      const rangeDiff = Math.abs(data.range_from_earth_km - last.range_from_earth_km);
      if (timeDiffMs > 0 && timeDiffMs < 120000 && rangeDiff > 50000) {
        console.log(`[DB] Rejected: impossible jump ${rangeDiff} km in ${Math.round(timeDiffMs/1000)}s`);
        return false;
      }
    }

    // Don't store duplicate timestamps
    const existing = await pool.query(
      'SELECT id FROM telemetry WHERE data_timestamp = $1',
      [data.timestamp]
    );
    if (existing.rows.length > 0) return true; // already stored

    await pool.query(
      `INSERT INTO telemetry
        (timestamp, data_timestamp, x, y, z, vx, vy, vz, altitude_km, speed_m_s, range_from_earth_km, range_from_moon_km, source)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        data.timestamp,
        data.position.x, data.position.y, data.position.z,
        data.velocity.vx, data.velocity.vy, data.velocity.vz,
        data.altitude_km, data.speed_m_s,
        data.range_from_earth_km, data.range_from_moon_km,
        data.source || 'horizons'
      ]
    );
    console.log(`[DB] Stored telemetry: ${data.timestamp} ALT ${data.altitude_km} km`);
    return true;
  } catch (err) {
    console.error('[DB] Store telemetry failed:', err.message);
    return false;
  }
}

async function getLatestTelemetry() {
  try {
    const res = await pool.query(
      'SELECT * FROM telemetry WHERE validated = true ORDER BY timestamp DESC LIMIT 1'
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('[DB] Get latest failed:', err.message);
    return null;
  }
}

async function getTelemetryHistory(limit = 100) {
  try {
    const res = await pool.query(
      'SELECT data_timestamp, altitude_km, speed_m_s, range_from_earth_km, range_from_moon_km, x, y, z FROM telemetry WHERE validated = true ORDER BY timestamp ASC LIMIT $1',
      [limit]
    );
    return res.rows;
  } catch (err) {
    console.error('[DB] Get history failed:', err.message);
    return [];
  }
}

async function getTelemetryNearTime(targetTime) {
  try {
    const res = await pool.query(
      `SELECT * FROM telemetry WHERE validated = true
       ORDER BY ABS(EXTRACT(EPOCH FROM (timestamp - $1::timestamptz))) ASC LIMIT 1`,
      [targetTime]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('[DB] Get near time failed:', err.message);
    return null;
  }
}

// ─── MISSION EVENTS ───

async function storeEvent(type, description, source, rawData) {
  try {
    const existing = await pool.query(
      'SELECT id FROM mission_events WHERE event_type = $1 AND description = $2 ORDER BY timestamp DESC LIMIT 1',
      [type, description]
    );
    // Don't store exact duplicates within 5 minutes
    if (existing.rows.length > 0) return;

    await pool.query(
      'INSERT INTO mission_events (event_type, description, source, raw_data) VALUES ($1, $2, $3, $4)',
      [type, description, source, rawData ? JSON.stringify(rawData) : null]
    );
    console.log(`[DB] Event: ${type} — ${description}`);
  } catch (err) {
    console.error('[DB] Store event failed:', err.message);
  }
}

async function getEvents(limit = 50) {
  try {
    const res = await pool.query(
      'SELECT * FROM mission_events ORDER BY timestamp DESC LIMIT $1',
      [limit]
    );
    return res.rows;
  } catch (err) {
    console.error('[DB] Get events failed:', err.message);
    return [];
  }
}

module.exports = {
  pool,
  initDB,
  storeTelemetry,
  getLatestTelemetry,
  getTelemetryHistory,
  getTelemetryNearTime,
  storeEvent,
  getEvents,
};
