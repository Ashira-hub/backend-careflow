// server.js
import express from "express";
import pg from "pg";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";

const { Pool } = pg;
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Helper to extract current user id from headers
function getUserId(req) {
  try {
    const h = req.headers || {};
    const xu = h["x-user-id"] || h["x-userid"]; // allow both
    const auth = h["authorization"]; // supports "Bearer <userId>"
    let id = null;
    if (xu !== undefined) id = Number(xu);
    else if (typeof auth === "string" && auth.startsWith("Bearer "))
      id = Number(auth.slice(7));
    if (!Number.isFinite(id)) return null;
    return id;
  } catch {
    return null;
  }
}

// PostgreSQL connection
const pool = new Pool({
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "caboose.proxy.rlwy.net",
  database: process.env.PGDATABASE || "railway",
  password: process.env.PGPASSWORD || "WtziBHNgEUmPZrDgBRccZyUORgMuHGtM",
  port: Number(process.env.PGPORT) || 24200,
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Insert a row into activity_log; best-effort (errors are swallowed)
async function logActivity(userId, type, title, details) {
  try {
    if (!Number.isFinite(Number(userId))) return;
    await pool.query(
      "INSERT INTO activity_log (user_id, type, title, details) VALUES ($1, $2, $3, $4)",
      [
        Number(userId),
        type || null,
        title || null,
        details ? JSON.stringify(details) : null,
      ],
    );
  } catch (e) {
    console.warn("activity log failed:", e?.message);
  }
}

// Function to ensure the database schema exists
async function ensureSchema() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Create users table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        specialty TEXT,
        phone TEXT,
        address TEXT,
        birthdate TEXT,
        gender TEXT,
        avatar_uri TEXT,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);

    // Create activity_log table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);

    // Create patients table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id SERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        email TEXT UNIQUE,
        phone TEXT,
        address TEXT,
        birthdate TEXT,
        gender TEXT,
        blood_type TEXT,
        height TEXT,
        weight TEXT,
        medical_history TEXT,
        allergies TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);

    // Create appointments table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        patient TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        specialty TEXT,
        notes TEXT,
        done BOOLEAN DEFAULT FALSE,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by_name TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);

    // Create schedule slots table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schedule_slots (
        id SERIAL PRIMARY KEY,
        doctor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        doctor_name TEXT,
        specialty TEXT,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        notes TEXT,
        status TEXT DEFAULT 'available',
        is_booked BOOLEAN DEFAULT FALSE,
        booked_appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);

    // Create lab_tests table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS lab_tests (
        id SERIAL PRIMARY KEY,
        test_name TEXT NOT NULL,
        patient TEXT NOT NULL,
        category TEXT,
        status TEXT,
        date TEXT,
        notes TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);

    // Create inventory table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        generic_name TEXT NOT NULL,
        brand_name TEXT,
        category TEXT NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by_name TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);

    // Create appointments compatibility table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointment (
        id SERIAL PRIMARY KEY,
        full_name TEXT,
        date TEXT,
        time TEXT,
        status TEXT,
        appointment_id INTEGER UNIQUE
      )`);

    // Create notifications table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);

    // Create prescriptions table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS prescriptions (
        id SERIAL PRIMARY KEY,
        patient_name TEXT NOT NULL,
        doctor_name TEXT NOT NULL,
        medicine TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        dosage_strength TEXT,
        description TEXT,
        status TEXT DEFAULT 'pending',
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);

    // Lab records table (for finalized/recorded lab results metadata)
    await client.query(`
      CREATE TABLE IF NOT EXISTS lab_records (
        id SERIAL PRIMARY KEY,
        test_name TEXT NOT NULL,
        patient TEXT NOT NULL,
        category TEXT,
        status TEXT,
        date TEXT,
        notes TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Ensure all necessary columns exist for older deployments
    await client.query(`
      DO $$
      BEGIN
        -- Ensure lab_records table has all required columns
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'lab_records' AND column_name = 'category') THEN
          ALTER TABLE lab_records ADD COLUMN category TEXT;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'lab_records' AND column_name = 'status') THEN
          ALTER TABLE lab_records ADD COLUMN status TEXT;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'lab_records' AND column_name = 'date') THEN
          ALTER TABLE lab_records ADD COLUMN date TEXT;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'lab_records' AND column_name = 'notes') THEN
          ALTER TABLE lab_records ADD COLUMN notes TEXT;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'lab_records' AND column_name = 'created_by_user_id') THEN
          ALTER TABLE lab_records ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);

    // Add any missing columns to existing tables
    await client.query(`
      DO $$
      BEGIN
        -- Add missing columns to appointments
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'appointments' AND column_name = 'created_by_user_id') THEN
          ALTER TABLE appointments ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'appointments' AND column_name = 'created_by_name') THEN
          ALTER TABLE appointments ADD COLUMN created_by_name TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'appointments' AND column_name = 'specialty') THEN
          ALTER TABLE appointments ADD COLUMN specialty TEXT;
        END IF;

        -- Add missing columns to schedule_slots
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'schedule_slots' AND column_name = 'doctor_user_id') THEN
          ALTER TABLE schedule_slots ADD COLUMN doctor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'schedule_slots' AND column_name = 'doctor_name') THEN
          ALTER TABLE schedule_slots ADD COLUMN doctor_name TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'schedule_slots' AND column_name = 'specialty') THEN
          ALTER TABLE schedule_slots ADD COLUMN specialty TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'schedule_slots' AND column_name = 'notes') THEN
          ALTER TABLE schedule_slots ADD COLUMN notes TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'schedule_slots' AND column_name = 'start_time') THEN
          ALTER TABLE schedule_slots ADD COLUMN start_time TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'schedule_slots' AND column_name = 'end_time') THEN
          ALTER TABLE schedule_slots ADD COLUMN end_time TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'schedule_slots' AND column_name = 'status') THEN
          ALTER TABLE schedule_slots ADD COLUMN status TEXT DEFAULT 'available';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'schedule_slots' AND column_name = 'is_booked') THEN
          ALTER TABLE schedule_slots ADD COLUMN is_booked BOOLEAN DEFAULT FALSE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'schedule_slots' AND column_name = 'booked_appointment_id') THEN
          ALTER TABLE schedule_slots ADD COLUMN booked_appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL;
        END IF;
        
        -- Add missing columns to lab_tests
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'lab_tests' AND column_name = 'created_by_user_id') THEN
          ALTER TABLE lab_tests ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        END IF;
        
        -- Add missing columns to inventory
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'inventory' AND column_name = 'created_by_user_id') THEN
          ALTER TABLE inventory ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'inventory' AND column_name = 'created_by_name') THEN
          ALTER TABLE inventory ADD COLUMN created_by_name TEXT;
        END IF;

        -- Add missing profile columns to users
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'users' AND column_name = 'blood_type') THEN
          ALTER TABLE users ADD COLUMN blood_type TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'users' AND column_name = 'height') THEN
          ALTER TABLE users ADD COLUMN height TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'users' AND column_name = 'weight') THEN
          ALTER TABLE users ADD COLUMN weight TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'users' AND column_name = 'allergies') THEN
          ALTER TABLE users ADD COLUMN allergies TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'users' AND column_name = 'medical_history') THEN
          ALTER TABLE users ADD COLUMN medical_history TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'users' AND column_name = 'active') THEN
          ALTER TABLE users ADD COLUMN active BOOLEAN DEFAULT TRUE;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'users' AND column_name = 'created_at') THEN
          ALTER TABLE users ADD COLUMN created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'users' AND column_name = 'updated_at') THEN
          ALTER TABLE users ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'users' AND column_name = 'specialty') THEN
          ALTER TABLE users ADD COLUMN specialty TEXT;
        END IF;
      END
      $$;
    `);

    // Backfill after migrations (in case schedule_slots columns were added above)
    try {
      await client.query(
        "UPDATE schedule_slots SET start_time = COALESCE(start_time, time), end_time = COALESCE(end_time, time) WHERE start_time IS NULL OR end_time IS NULL",
      );
    } catch {}

    console.log("✅ Database schema verified/updated successfully");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error ensuring database schema:", error);
    throw error;
  } finally {
    client.release();
  }
}

// Initialize the server
async function initializeServer() {
  try {
    // Ensure database schema is up to date
    await ensureSchema();
    console.log("✅ Database initialization complete");

    // Start the server
    const PORT = process.env.PORT || 5000;
    return new Promise((resolve) => {
      const server = app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log("✅ Server started successfully");
        resolve(server);
      });
    });
  } catch (error) {
    console.error("❌ Failed to initialize server:", error);
    process.exit(1);
  }
}

// Root endpoint
app.get("/", (req, res) => {
  res.json({ message: "Welcome to the CareFlow API" });
});

// Error handling middleware (must be after all other middleware and routes)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
  process.exit(1);
});

// Start the server if this file is run directly
if (process.env.NODE_ENV !== "test") {
  initializeServer().catch((error) => {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  });
}

// Export the app and initializeServer for testing
export { app, initializeServer };
export default app;

// Routes
// ===== Activity API =====
app.get("/api/activity", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const result = await pool.query(
      "SELECT id, type, title, details, created_at FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/activity error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/notifications", async (req, res) => {
  try {
    const senderId = getUserId(req);
    if (!senderId) return res.status(401).json({ message: "Unauthorized" });
    const body = req.body || {};
    const title = String(body.title || "Notification").trim();
    const message = String(body.message || "").trim();
    if (!title || !message)
      return res.status(400).json({ message: "Missing title or message" });

    const idCandidate =
      body.user_id ?? body.userId ?? body.toUserId ?? body.recipientId;
    const nameCandidate =
      body.toName ?? body.recipientName ?? body.doctorName ?? body.to;

    let targetUserId = Number(idCandidate);
    if (!Number.isFinite(targetUserId)) {
      targetUserId = NaN;
    }
    if (!Number.isFinite(targetUserId)) {
      const name = String(nameCandidate || "").trim();
      if (!name)
        return res
          .status(400)
          .json({ message: "Missing recipient user id or name" });
      const ures = await pool.query(
        "SELECT id FROM users WHERE LOWER(full_name) = LOWER($1) LIMIT 1",
        [name],
      );
      if (ures.rowCount === 0) {
        const ures2 = await pool.query(
          "SELECT id FROM users WHERE LOWER(full_name) LIKE LOWER($1) ORDER BY id ASC LIMIT 1",
          [`%${name}%`],
        );
        if (ures2.rowCount === 0)
          return res.status(404).json({ message: "Recipient not found" });
        targetUserId = Number(ures2.rows[0].id);
      } else {
        targetUserId = Number(ures.rows[0].id);
      }
    }

    const ins = await pool.query(
      "INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3) RETURNING id, title, message, read, created_at",
      [targetUserId, title, message],
    );
    try {
      logActivity(senderId, "notification", `Sent notification: ${title}`, {
        to_user_id: targetUserId,
        title,
      });
    } catch {}
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    console.error("POST /api/notifications error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// List prescriptions (optionally filter by status)
app.get("/api/prescriptions", async (req, res) => {
  try {
    const status =
      typeof req.query?.status === "string"
        ? String(req.query.status).trim().toLowerCase()
        : null;
    let result;
    if (status) {
      result = await pool.query(
        `SELECT id, doctor_name, patient_name, medicine, quantity, dosage_strength, description, status, created_by_user_id, created_at
           FROM prescription
           WHERE LOWER(COALESCE(status,'')) = $1
           ORDER BY created_at DESC`,
        [status],
      );
    } else {
      result = await pool.query(
        `SELECT id, doctor_name, patient_name, medicine, quantity, dosage_strength, description, status, created_by_user_id, created_at
           FROM prescription
           ORDER BY created_at DESC`,
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/prescriptions error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Laboratory Records API
// Create a new lab record
app.post("/api/lab-records", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { test_name, patient, category, status, date, notes } =
      req.body || {};
    if (!test_name || !patient)
      return res.status(400).json({ message: "Missing required fields" });
    const insert = await pool.query(
      `INSERT INTO lab_records (test_name, patient, category, status, date, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, test_name, patient, category, status, date, notes, created_by_user_id AS "createdByUserId", created_at AS "createdAt"`,
      [
        String(test_name).trim(),
        String(patient).trim(),
        category || null,
        status || null,
        date || null,
        notes || null,
        userId,
      ],
    );
    const row = insert.rows[0];
    logActivity(
      userId,
      "records",
      `Lab record added: ${row.test_name} • ${row.patient}`,
      row,
    );
    res.status(201).json(row);
  } catch (err) {
    console.error("POST /api/lab-records error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// List lab records for current user
app.get("/api/lab-records", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const result = await pool.query(
      `SELECT id, test_name, patient, category, status, date, notes, created_by_user_id AS "createdByUserId", created_at AS "createdAt"
         FROM lab_records
         WHERE created_by_user_id = $1 OR created_by_user_id IS NULL
         ORDER BY id DESC`,
      [userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/lab-records error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Laboratory Tests API
// Create a new lab test
app.post("/api/lab-tests", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { test_name, patient, category, status, date, notes } =
      req.body || {};
    if (!test_name || !patient)
      return res.status(400).json({ message: "Missing required fields" });
    const insert = await pool.query(
      `INSERT INTO lab_tests (test_name, patient, category, status, date, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, test_name, patient, category, status, date, notes, created_by_user_id AS "createdByUserId", created_at AS "createdAt"`,
      [
        String(test_name).trim(),
        String(patient).trim(),
        category || null,
        status || null,
        date || null,
        notes || null,
        userId,
      ],
    );
    const row = insert.rows[0];
    // Mirror into lab_records so records reflect tests
    try {
      await pool.query(
        `INSERT INTO lab_records (test_name, patient, category, status, date, notes, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          row.test_name,
          row.patient,
          row.category || null,
          row.status || null,
          row.date || null,
          row.notes || null,
          userId,
        ],
      );
    } catch (e) {
      console.warn("mirror lab_test to lab_records failed:", e?.message);
    }
    // Log activity
    logActivity(
      userId,
      "lab",
      `Lab test added: ${row.test_name} • ${row.patient}`,
      row,
    );
    res.status(201).json(row);
  } catch (err) {
    console.error("POST /api/lab-tests error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// List lab tests for the current user
app.get("/api/lab-tests", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    // Get user's full name to match patient column
    const userRes = await pool.query(
      "SELECT full_name FROM users WHERE id = $1",
      [userId],
    );
    const userFullName = userRes.rows[0]?.full_name || "";
    const result = await pool.query(
      `SELECT id, test_name, patient, category, status, date, notes, created_by_user_id AS "createdByUserId", created_at AS "createdAt"
         FROM lab_tests
         WHERE created_by_user_id = $1 OR created_by_user_id IS NULL OR LOWER(patient) = LOWER($2)
         ORDER BY id DESC`,
      [userId, userFullName],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/lab-tests error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update a lab test status (and mirror into lab_records)
app.put("/api/lab-tests/:id/status", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    const { status } = req.body || {};
    if (typeof status !== "string" || !status.trim())
      return res.status(400).json({ message: "Missing status" });
    const clean = String(status).trim();
    const upd = await pool.query(
      `UPDATE lab_tests
         SET status = $1
         WHERE id = $2 AND (created_by_user_id = $3 OR created_by_user_id IS NULL)
         RETURNING id, test_name, patient, category, status, date, notes, created_by_user_id AS "createdByUserId", created_at AS "createdAt"`,
      [clean, id, userId],
    );
    if (upd.rowCount === 0)
      return res.status(404).json({ message: "Lab test not found" });
    const row = upd.rows[0];
    // Mirror update into lab_records by matching core identity fields
    try {
      await pool.query(
        `UPDATE lab_records
           SET status = $1
           WHERE test_name = $2 AND patient = $3 AND (date = $4 OR $4 IS NULL) AND (created_by_user_id = $5 OR created_by_user_id IS NULL)`,
        [clean, row.test_name, row.patient, row.date || null, userId],
      );
    } catch (e) {
      console.warn("mirror status to lab_records failed:", e?.message);
    }
    logActivity(
      userId,
      "lab",
      `Lab test status updated: ${row.test_name} • ${row.patient} -> ${clean}`,
      { id: row.id, status: clean },
    );
    res.json(row);
  } catch (err) {
    console.error("PUT /api/lab-tests/:id/status error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Supervisor Schedules API
// Create schedule
app.post("/api/schedules", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { nurse, title, station, date, startTime, endTime, note } =
      req.body || {};
    if (!title || !date)
      return res.status(400).json({ message: "Missing required fields" });
    const insert = await pool.query(
      `INSERT INTO schedules (nurse, title, station, date, start_time, end_time, note, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, nurse, title, station, date, start_time AS "startTime", end_time AS "endTime", note, created_by_user_id AS "createdByUserId", created_at AS "createdAt"`,
      [
        nurse || null,
        String(title).trim(),
        station || null,
        String(date).trim(),
        startTime || null,
        endTime || null,
        note || null,
        userId,
      ],
    );
    logActivity(
      userId,
      "schedule",
      `Schedule created: ${title} • ${date}`,
      insert.rows[0],
    );
    res.status(201).json(insert.rows[0]);
  } catch (err) {
    console.error("POST /api/schedules error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// List schedules for current user
app.get("/api/schedules", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const result = await pool.query(
      `SELECT id, nurse, title, station, date, start_time AS "startTime", end_time AS "endTime", note, created_by_user_id AS "createdByUserId", created_at AS "createdAt"
         FROM schedules WHERE created_by_user_id = $1 ORDER BY id DESC`,
      [userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/schedules error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update schedule
app.put("/api/schedules/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    const { nurse, title, station, date, startTime, endTime, note } =
      req.body || {};
    const result = await pool.query(
      `UPDATE schedules
         SET nurse = COALESCE($1, nurse),
             title = COALESCE($2, title),
             station = COALESCE($3, station),
             date = COALESCE($4, date),
             start_time = COALESCE($5, start_time),
             end_time = COALESCE($6, end_time),
             note = COALESCE($7, note)
         WHERE id = $8 AND created_by_user_id = $9
         RETURNING id, nurse, title, station, date, start_time AS "startTime", end_time AS "endTime", note, created_by_user_id AS "createdByUserId", created_at AS "createdAt"`,
      [
        nurse ?? null,
        title ?? null,
        station ?? null,
        date ?? null,
        startTime ?? null,
        endTime ?? null,
        note ?? null,
        id,
        userId,
      ],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ message: "Schedule not found" });
    logActivity(
      userId,
      "schedule_update",
      `Schedule updated: ${result.rows[0].title} • ${result.rows[0].date}`,
      result.rows[0],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /api/schedules/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Delete schedule
app.delete("/api/schedules/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    const del = await pool.query(
      "DELETE FROM schedules WHERE id = $1 AND created_by_user_id = $2",
      [id, userId],
    );
    if (del.rowCount === 0)
      return res.status(404).json({ message: "Schedule not found" });
    logActivity(userId, "schedule_delete", `Schedule deleted: ${id}`, { id });
    res.status(204).send();
  } catch (err) {
    console.error("DELETE /api/schedules/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update prescription status (e.g., accepted by pharmacy) and notify doctor
app.put("/api/prescription/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    const clean =
      typeof status === "string" ? status.trim().toLowerCase() : null;
    if (!clean) return res.status(400).json({ message: "Missing status" });
    const upd = await pool.query(
      "UPDATE prescription SET status = $1 WHERE id = $2 RETURNING id, doctor_name, patient_name, medicine, quantity, dosage_strength, description, created_by_user_id, status, created_at",
      [clean, id],
    );
    if (upd.rowCount === 0)
      return res.status(404).json({ message: "Prescription not found" });
    const row = upd.rows[0];
    try {
      if (clean === "accepted" && row.created_by_user_id) {
        const title = "Prescription Accepted";
        const message = `Pharmacy accepted prescription for ${row.patient_name} • ${row.medicine}`;
        await pool.query(
          "INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)",
          [row.created_by_user_id, title, message],
        );
        logActivity(row.created_by_user_id, "prescription", message, {
          id: row.id,
          status: clean,
        });
      }
    } catch (e) {
      console.warn("notify doctor failed:", e?.message);
    }
    res.json(row);
  } catch (err) {
    console.error("PUT /api/prescription/:id/status error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Notifications API
// List notifications for current user
app.get("/api/notifications", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 100));
    const result = await pool.query(
      "SELECT id, title, message, read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/notifications error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Mark a notification as read
app.put("/api/notifications/:id/read", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    const upd = await pool.query(
      "UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id, title, message, read, created_at",
      [id, userId],
    );
    if (upd.rowCount === 0)
      return res.status(404).json({ message: "Notification not found" });
    res.json(upd.rows[0]);
  } catch (err) {
    console.error("PUT /api/notifications/:id/read error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Add a custom activity item for current user
app.post("/api/activity", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { type, title, details } = req.body || {};
    const ins = await pool.query(
      "INSERT INTO activity_log (user_id, type, title, details) VALUES ($1, $2, $3, $4) RETURNING id, type, title, details, created_at",
      [
        userId,
        type || null,
        title || null,
        details ? JSON.stringify(details) : null,
      ],
    );
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    console.error("POST /api/activity error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/users", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, full_name, role, email, active, created_at FROM users ORDER BY id DESC",
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /users error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// Update current user's profile
app.put("/api/users/:id", async (req, res) => {
  try {
    const authUserId = getUserId(req);
    if (!authUserId) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    if (String(authUserId) !== String(id))
      return res.status(403).json({ message: "Forbidden" });

    const {
      full_name,
      fullName,
      name,
      email,
      phone,
      address,
      birthdate,
      gender,
      avatar_uri,
      specialty,
      blood_type,
      height,
      weight,
      allergies,
      medical_history,
    } = req.body || {};

    const desiredName =
      (typeof full_name === "string" && full_name.trim()) ||
      (typeof fullName === "string" && fullName.trim()) ||
      (typeof name === "string" && name.trim()) ||
      null;

    const cleanSpecialty =
      typeof specialty === "string" && specialty.trim()
        ? specialty.trim()
        : null;

    const paramsBase = [
      desiredName,
      typeof email === "string" ? email : null,
      typeof phone === "string" ? phone : null,
      typeof address === "string" ? address : null,
      typeof birthdate === "string" ? birthdate : null,
      typeof gender === "string" ? gender : null,
      typeof avatar_uri === "string" ? avatar_uri : null,
      typeof blood_type === "string" ? blood_type : null,
      typeof height === "string" ? height : null,
      typeof weight === "string" ? weight : null,
      typeof allergies === "string" ? allergies : null,
      typeof medical_history === "string" ? medical_history : null,
    ];

    let result;
    try {
      // New schema: includes specialty + updated_at
      result = await pool.query(
        `UPDATE users SET
           full_name = COALESCE($1, full_name),
           email = COALESCE($2, email),
           phone = COALESCE($3, phone),
           address = COALESCE($4, address),
           birthdate = COALESCE($5, birthdate),
           gender = COALESCE($6, gender),
           avatar_uri = COALESCE($7, avatar_uri),
           blood_type = COALESCE($8, blood_type),
           height = COALESCE($9, height),
           weight = COALESCE($10, weight),
           allergies = COALESCE($11, allergies),
           medical_history = COALESCE($12, medical_history),
           specialty = COALESCE($13, specialty),
           updated_at = NOW()
         WHERE id = $14
         RETURNING id, full_name, email, phone, address, birthdate, gender, avatar_uri, blood_type, height, weight, allergies, medical_history, specialty, role, active, created_at, updated_at`,
        [...paramsBase, cleanSpecialty, id],
      );
    } catch (e) {
      const msg = String(e?.message || "");
      const missingSpecialty =
        (e && e.code === "42703" && /specialty/i.test(msg)) ||
        /column\s+"specialty"/i.test(msg);
      const missingUpdatedAt =
        (e && e.code === "42703" && /updated_at/i.test(msg)) ||
        /column\s+"updated_at"/i.test(msg);

      try {
        if (missingUpdatedAt && !missingSpecialty) {
          // Old schema: specialty exists, but updated_at doesn't
          result = await pool.query(
            `UPDATE users SET
               full_name = COALESCE($1, full_name),
               email = COALESCE($2, email),
               phone = COALESCE($3, phone),
               address = COALESCE($4, address),
               birthdate = COALESCE($5, birthdate),
               gender = COALESCE($6, gender),
               avatar_uri = COALESCE($7, avatar_uri),
               blood_type = COALESCE($8, blood_type),
               height = COALESCE($9, height),
               weight = COALESCE($10, weight),
               allergies = COALESCE($11, allergies),
               medical_history = COALESCE($12, medical_history),
               specialty = COALESCE($13, specialty)
             WHERE id = $14
             RETURNING id, full_name, email, phone, address, birthdate, gender, avatar_uri, blood_type, height, weight, allergies, medical_history, specialty, role, active`,
            [...paramsBase, cleanSpecialty, id],
          );
        } else if (missingSpecialty && !missingUpdatedAt) {
          // Old schema: updated_at exists, but specialty doesn't
          result = await pool.query(
            `UPDATE users SET
               full_name = COALESCE($1, full_name),
               email = COALESCE($2, email),
               phone = COALESCE($3, phone),
               address = COALESCE($4, address),
               birthdate = COALESCE($5, birthdate),
               gender = COALESCE($6, gender),
               avatar_uri = COALESCE($7, avatar_uri),
               blood_type = COALESCE($8, blood_type),
               height = COALESCE($9, height),
               weight = COALESCE($10, weight),
               allergies = COALESCE($11, allergies),
               medical_history = COALESCE($12, medical_history),
               updated_at = NOW()
             WHERE id = $13
             RETURNING id, full_name, email, phone, address, birthdate, gender, avatar_uri, blood_type, height, weight, allergies, medical_history, role, active, created_at, updated_at`,
            [...paramsBase, id],
          );
        } else if (missingSpecialty && missingUpdatedAt) {
          // Very old schema: neither specialty nor updated_at
          result = await pool.query(
            `UPDATE users SET
               full_name = COALESCE($1, full_name),
               email = COALESCE($2, email),
               phone = COALESCE($3, phone),
               address = COALESCE($4, address),
               birthdate = COALESCE($5, birthdate),
               gender = COALESCE($6, gender),
               avatar_uri = COALESCE($7, avatar_uri),
               blood_type = COALESCE($8, blood_type),
               height = COALESCE($9, height),
               weight = COALESCE($10, weight),
               allergies = COALESCE($11, allergies),
               medical_history = COALESCE($12, medical_history)
             WHERE id = $13
             RETURNING id, full_name, email, phone, address, birthdate, gender, avatar_uri, blood_type, height, weight, allergies, medical_history, role, active`,
            [...paramsBase, id],
          );
        } else {
          throw e;
        }
      } catch (e3) {
        throw e3;
      }
    }

    if (result.rowCount === 0)
      return res.status(404).json({ message: "User not found" });

    const row = result.rows[0] || {};
    if (row && row.specialty === undefined) row.specialty = cleanSpecialty;
    res.json(row);
  } catch (err) {
    console.error("PUT /api/users/:id error:", err);
    res.status(500).json({
      message: "Server error",
      error: err?.message || String(err),
      code: err?.code,
    });
  }
});

// Update inventory details (name/category/stock)
app.put("/api/inventory/:id", async (req, res) => {
  try {
    const { id } = req.params;
    // Accept either split fields or a combined name ("Generic (Brand)")
    let { genericName, brandName, category, stock } = req.body || {};
    if (!genericName && typeof req.body?.name === "string") {
      const name = String(req.body.name);
      const m = name.match(/^\s*(.*?)\s*(?:\((.*?)\))?\s*$/);
      genericName = m ? (m[1] || "").trim() : name.trim();
      brandName = m ? (m[2] || "").trim() || null : null;
    }
    const result = await pool.query(
      `UPDATE inventory
         SET generic_name = COALESCE($1, generic_name),
             brand_name = COALESCE($2, brand_name),
             category = COALESCE($3, category),
             stock = COALESCE($4, stock)
         WHERE id = $5
         RETURNING id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at`,
      [
        genericName ?? null,
        brandName ?? null,
        category ?? null,
        Number.isFinite(Number(stock)) ? Number(stock) : null,
        id,
      ],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ message: "Inventory item not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /api/inventory/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Patch stock only
app.patch("/api/inventory/:id/stock", async (req, res) => {
  try {
    const { id } = req.params;
    const { stock, delta } = req.body || {};
    if (typeof stock !== "number" && typeof delta !== "number") {
      return res
        .status(400)
        .json({ message: "Provide stock or delta as a number" });
    }
    let result;
    if (typeof delta === "number") {
      result = await pool.query(
        `UPDATE inventory SET stock = GREATEST(0, stock + $1) WHERE id = $2
           RETURNING id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at`,
        [delta, id],
      );
    } else {
      result = await pool.query(
        `UPDATE inventory SET stock = GREATEST(0, $1) WHERE id = $2
           RETURNING id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at`,
        [Number(stock), id],
      );
    }
    if (result.rowCount === 0)
      return res.status(404).json({ message: "Inventory item not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /api/inventory/:id/stock error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Pharmacy Inventory API
app.post("/api/inventory", async (req, res) => {
  try {
    const {
      category,
      brandName,
      genericName,
      dosageType,
      strength,
      unit,
      expirationDate,
      stock,
      description,
    } = req.body || {};
    if (!genericName)
      return res.status(400).json({ message: "Missing genericName" });
    const result = await pool.query(
      `INSERT INTO inventory (category, brand_name, generic_name, dosage_type, strength, unit, expiration_date, stock, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at`,
      [
        category || null,
        brandName || null,
        String(genericName).trim(),
        dosageType || null,
        strength || null,
        unit || null,
        expirationDate || null,
        Number.isFinite(Number(stock)) ? Number(stock) : 0,
        description || null,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/inventory error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/inventory", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at FROM inventory ORDER BY created_at DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/inventory error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Return all patient records (with timestamps and fields) for reporting
app.get("/api/patient-records/all", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const result = await pool.query(
      `SELECT id, patient, date, time, notes, doctor, medicine, dosage, created_at
         FROM patient_records
         WHERE created_by_user_id = $1 OR created_by_user_id IS NULL
         ORDER BY created_at DESC`,
      [userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/patient-records/all error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Merge into latest record for a patient (avoid duplicates)
app.put("/api/patient-records/latest", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { patient, doctor, medicine, dosage, notes, date, time } =
      req.body || {};
    if (!patient) return res.status(400).json({ message: "Missing patient" });
    // Try update latest row for this patient
    const update = await pool.query(
      `WITH latest AS (
           SELECT id FROM patient_records WHERE patient = $1 AND created_by_user_id = $2 ORDER BY created_at DESC LIMIT 1
         )
         UPDATE patient_records pr
         SET doctor = COALESCE($2, pr.doctor),
             medicine = COALESCE($3, pr.medicine),
             dosage = COALESCE($4, pr.dosage),
             notes = COALESCE($5, pr.notes),
             date = COALESCE($6, pr.date),
             time = COALESCE($7, pr.time)
         FROM latest
         WHERE pr.id = latest.id
         RETURNING pr.id, pr.patient, pr.date, pr.time, pr.notes, pr.doctor, pr.medicine, pr.dosage, pr.created_at`,
      [
        String(patient).trim(),
        userId,
        doctor ?? null,
        medicine ?? null,
        dosage ?? null,
        notes ?? null,
        date ?? null,
        time ?? null,
      ],
    );
    if (update.rowCount > 0) return res.json(update.rows[0]);
    // If no existing, insert new
    const insert = await pool.query(
      "INSERT INTO patient_records (patient, date, time, notes, doctor, medicine, dosage, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, patient, date, time, notes, doctor, medicine, dosage, created_at",
      [
        String(patient).trim(),
        date ?? null,
        time ?? null,
        notes ?? null,
        doctor ?? null,
        medicine ?? null,
        dosage ?? null,
        userId,
      ],
    );
    // Log activity for upsert
    logActivity(userId, "records", `Patient record updated: ${patient}`, {
      patient,
      doctor,
      medicine,
      dosage,
      notes,
      id: insert.rows[0]?.id,
    });
    res.json(insert.rows[0]);
  } catch (err) {
    console.error("PUT /api/patient-records/latest error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Patient Records API (for Doctor Patient Records screen)
// Ensure table for storing patient record entries (appointment completions, etc.)
try {
  await pool.query(`
      CREATE TABLE IF NOT EXISTS patient_records (
        id SERIAL PRIMARY KEY,
        patient TEXT NOT NULL,
        date TEXT,
        time TEXT,
        notes TEXT,
        doctor TEXT,
        medicine TEXT,
        dosage TEXT,
        created_by_user_id INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
  // Ensure new columns exist for existing deployments
  await pool.query(
    `ALTER TABLE patient_records ADD COLUMN IF NOT EXISTS doctor TEXT;`,
  );
  await pool.query(
    `ALTER TABLE patient_records ADD COLUMN IF NOT EXISTS medicine TEXT;`,
  );
  await pool.query(
    `ALTER TABLE patient_records ADD COLUMN IF NOT EXISTS dosage TEXT;`,
  );
  await pool.query(
    `ALTER TABLE patient_records ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER;`,
  );
} catch (e) {
  console.error("ensure patient_records table error:", e);
}

// Add a patient record entry
app.post("/api/patient-records", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { patient, date, time, notes, doctor, medicine, dosage } =
      req.body || {};
    if (!patient) return res.status(400).json({ message: "Missing patient" });
    const insert = await pool.query(
      "INSERT INTO patient_records (patient, date, time, notes, doctor, medicine, dosage, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, patient, date, time, notes, doctor, medicine, dosage, created_at",
      [
        String(patient).trim(),
        date || null,
        time || null,
        notes || null,
        doctor ? String(doctor).trim() : null,
        medicine ? String(medicine).trim() : null,
        dosage ? String(dosage).trim() : null,
        userId,
      ],
    );
    // Log activity
    logActivity(userId, "records", `Patient record added: ${patient}`, {
      patient,
      doctor,
      medicine,
      dosage,
      notes,
      id: insert.rows[0]?.id,
    });
    res.status(201).json(insert.rows[0]);
  } catch (err) {
    console.error("POST /api/patient-records error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// List distinct patients with latest record timestamp
app.get("/api/patient-records", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const ownOnly = String(req.query?.own || "").trim() === "1";
    const sql = ownOnly
      ? `SELECT patient, MAX(created_at) AS last_ts
           FROM patient_records
           WHERE created_by_user_id = $1
           GROUP BY patient
           ORDER BY last_ts DESC`
      : `SELECT patient, MAX(created_at) AS last_ts
           FROM patient_records
           WHERE created_by_user_id = $1 OR created_by_user_id IS NULL
           GROUP BY patient
           ORDER BY last_ts DESC`;
    const result = await pool.query(sql, [userId]);
    res.json(
      result.rows.map((r) => ({ patient: r.patient, last_ts: r.last_ts })),
    );
  } catch (err) {
    console.error("GET /api/patient-records error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Doctor Appointments API
// Create appointment
app.post("/api/appointments", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const body = req.body || {};
    const patient = body.patient;
    const date = body.date;
    const time = body.time;
    const notes = body.notes;
    const specialtyCandidate =
      body.specialty || body.doctor_specialty || body.doctorSpecialty;
    const done = body.done ?? false;
    const doctorUserIdCandidate =
      body.doctor_user_id ??
      body.doctorUserId ??
      body.doctor_id ??
      body.doctorId;
    const createdByName =
      body.createdByName ||
      body.created_by_name ||
      body.doctorName ||
      body.doctor_name;
    if (!patient || !date || !time) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    let role = null;
    try {
      const ures = await pool.query("SELECT role FROM users WHERE id = $1", [
        userId,
      ]);
      role =
        ures.rowCount > 0 && ures.rows[0]?.role
          ? String(ures.rows[0].role).toLowerCase()
          : null;
    } catch {}

    let assignedDoctorUserId = userId;
    if (role === "patient") {
      let did = Number(doctorUserIdCandidate);
      if (!Number.isFinite(did)) did = NaN;

      if (Number.isFinite(did)) {
        const dchk = await pool.query(
          "SELECT id FROM users WHERE id = $1 AND role ILIKE 'doctor' LIMIT 1",
          [did],
        );
        if (dchk.rowCount === 0) {
          return res.status(404).json({ message: "Doctor not found" });
        }
        assignedDoctorUserId = Number(dchk.rows[0].id);
      } else {
        const docName = String(createdByName || "").trim();
        if (!docName)
          return res.status(400).json({ message: "Missing doctor name" });
        let dres = await pool.query(
          "SELECT id FROM users WHERE role ILIKE 'doctor' AND LOWER(full_name) = LOWER($1) LIMIT 1",
          [docName],
        );
        if (dres.rowCount === 0) {
          dres = await pool.query(
            "SELECT id FROM users WHERE role ILIKE 'doctor' AND LOWER(full_name) LIKE LOWER($1) ORDER BY id ASC LIMIT 1",
            [`%${docName}%`],
          );
        }
        if (dres.rowCount === 0)
          return res.status(404).json({ message: "Doctor not found" });
        assignedDoctorUserId = Number(dres.rows[0].id);
      }
    }

    let finalSpecialty =
      typeof specialtyCandidate === "string" && specialtyCandidate.trim()
        ? specialtyCandidate.trim()
        : null;
    if (!finalSpecialty) {
      try {
        const sres = await pool.query(
          "SELECT specialty FROM users WHERE id = $1 LIMIT 1",
          [assignedDoctorUserId],
        );
        if (sres.rowCount > 0 && sres.rows[0]?.specialty)
          finalSpecialty = String(sres.rows[0].specialty).trim() || null;
      } catch {}
    }

    let insert;
    try {
      insert = await pool.query(
        "INSERT INTO appointments (patient, date, time, specialty, notes, done, created_by_name, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, patient, date, time, specialty, notes, done, created_by_name, created_at",
        [
          String(patient).trim(),
          String(date).trim(),
          String(time).trim(),
          finalSpecialty,
          notes || null,
          Boolean(done),
          createdByName ? String(createdByName).trim() : null,
          assignedDoctorUserId,
        ],
      );
    } catch (e) {
      // If DB hasn't been migrated to add appointments.specialty yet
      if (
        (e && e.code === "42703") ||
        /column\s+"specialty"/i.test(String(e?.message || ""))
      ) {
        insert = await pool.query(
          "INSERT INTO appointments (patient, date, time, notes, done, created_by_name, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, patient, date, time, notes, done, created_by_name, created_at",
          [
            String(patient).trim(),
            String(date).trim(),
            String(time).trim(),
            notes || null,
            Boolean(done),
            createdByName ? String(createdByName).trim() : null,
            assignedDoctorUserId,
          ],
        );
      } else {
        throw e;
      }
    }

    if (role === "patient") {
      try {
        const title = "Appointment Request";
        const apptId = insert?.rows?.[0]?.id;
        const idPart = apptId != null ? ` • ID:${String(apptId)}` : "";
        const msg = `New appointment request from ${String(patient).trim()} • ${String(
          date,
        ).trim()} ${String(time).trim()}${idPart}${notes ? ` • ${String(notes).trim()}` : ""}`;
        await pool.query(
          "INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)",
          [assignedDoctorUserId, title, msg],
        );
        logActivity(assignedDoctorUserId, "appointment", title, {
          appointment_id: insert.rows[0]?.id,
          patient,
          date,
          time,
        });
      } catch (e) {
        console.warn("notify doctor failed:", e?.message);
      }
    }
    // Also log into patient_records for unified reporting
    try {
      await pool.query(
        "INSERT INTO patient_records (patient, date, time, notes, doctor, medicine, dosage, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          String(patient).trim(),
          String(date).trim(),
          String(time).trim(),
          notes || null,
          createdByName ? String(createdByName).trim() : null,
          null,
          null,
          assignedDoctorUserId,
        ],
      );
    } catch (e) {
      console.warn("mirror appointment to patient_records failed:", e?.message);
    }
    // Also reflect into simplified table for UI: store patient full name, date, time, and status
    try {
      const status = Boolean(done) ? "done" : "pending";
      await pool.query(
        "INSERT INTO appointment (full_name, date, time, status, appointment_id) VALUES ($1, $2, $3, $4, $5)",
        [
          String(patient).trim(),
          String(date).trim(),
          String(time).trim(),
          status,
          insert.rows[0].id,
        ],
      );
    } catch {}
    // Log activity
    logActivity(
      userId,
      "appointment",
      `Appointment created: ${patient} • ${date} ${time}`,
      {
        id: insert.rows[0]?.id,
        patient,
        date,
        time,
        specialty: insert.rows[0]?.specialty,
        notes,
        done,
      },
    );
    res.status(201).json(insert.rows[0]);
  } catch (err) {
    console.error("POST /api/appointments error:", err);
    res.status(500).json({
      message: "Server error",
      error: err?.message || String(err),
      code: err?.code,
    });
  }
});

// List appointments (optional)
app.get("/api/appointments", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    // Determine requester role to tailor the response
    let role = null;
    let fullName = null;
    try {
      const ures = await pool.query(
        "SELECT role, full_name FROM users WHERE id = $1",
        [userId],
      );
      if (ures.rowCount > 0) {
        role =
          (ures.rows[0]?.role || null) &&
          String(ures.rows[0].role).toLowerCase();
        fullName = ures.rows[0]?.full_name || null;
      }
    } catch {}

    if (role === "patient") {
      // Return appointments for this patient by matching patient name (case-insensitive):
      // exact full-name OR any token match
      const name = (fullName || "").trim();
      if (!name) return res.json([]);
      const tokens = name.toLowerCase().split(/\s+/).filter(Boolean);
      const whereParts = [
        `LOWER(patient) = LOWER($1)`,
        `LOWER(patient) LIKE LOWER($2)`,
      ];
      const params = [name, `%${name}%`];
      tokens.forEach((tok, i) => {
        whereParts.push(`LOWER(patient) LIKE LOWER($${i + 3})`);
        params.push(`%${tok}%`);
      });
      const sql = `SELECT a.id, a.patient, a.date, a.time, a.notes, a.done, a.created_by_name, a.created_at,
        a.specialty,
        CASE
          WHEN a.done THEN 'done'
          WHEN LOWER(COALESCE(m.status, '')) = 'accepted' THEN 'accepted'
          ELSE 'pending'
        END AS status
      FROM appointments a
      LEFT JOIN appointment m ON m.appointment_id = a.id
      WHERE ${whereParts.join(" OR ")}
      ORDER BY a.id DESC`;
      const result = await pool.query(sql, params);
      return res.json(result.rows);
    }

    // Default: list appointments created by this user (doctor/other roles)
    const result = await pool.query(
      "SELECT id, patient, date, time, specialty, notes, done, created_by_name, created_at FROM appointments WHERE created_by_user_id = $1 ORDER BY id DESC",
      [userId],
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("GET /api/appointments error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update appointment
app.put("/api/appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { patient, date, time, notes, done, createdByName, specialty } =
      req.body || {};

    const actorUserId = getUserId(req);
    if (!actorUserId) return res.status(401).json({ message: "Unauthorized" });

    let actorRole = null;
    let actorName = null;
    try {
      const ures = await pool.query(
        "SELECT role, full_name FROM users WHERE id = $1",
        [actorUserId],
      );
      if (ures.rowCount > 0) {
        actorRole = ures.rows[0]?.role
          ? String(ures.rows[0].role).toLowerCase()
          : null;
        actorName = ures.rows[0]?.full_name || null;
      }
    } catch {}

    let before = null;
    try {
      const bres = await pool.query(
        "SELECT id, patient, date, time, specialty, done, created_by_name, created_by_user_id FROM appointments WHERE id = $1",
        [id],
      );
      before = bres.rowCount > 0 ? bres.rows[0] : null;
    } catch {}

    const result = await pool.query(
      "UPDATE appointments SET patient = COALESCE($1, patient), date = COALESCE($2, date), time = COALESCE($3, time), specialty = COALESCE($4, specialty), notes = COALESCE($5, notes), done = COALESCE($6, done), created_by_name = COALESCE($7, created_by_name) WHERE id = $8 RETURNING id, patient, date, time, specialty, notes, done, created_by_name, created_at",
      [
        patient ?? null,
        date ?? null,
        time ?? null,
        specialty ?? null,
        notes ?? null,
        typeof done === "boolean" ? done : null,
        createdByName ?? null,
        id,
      ],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ message: "Appointment not found" });
    const updated = result.rows[0];

    const oldDate = before?.date ? String(before.date) : null;
    const oldTime = before?.time ? String(before.time) : null;
    const newDate = updated?.date ? String(updated.date) : null;
    const newTime = updated?.time ? String(updated.time) : null;
    const dateChanged =
      oldDate != null && newDate != null && String(oldDate) !== String(newDate);
    const timeChanged =
      oldTime != null && newTime != null && String(oldTime) !== String(newTime);
    const isReschedule = dateChanged || timeChanged;

    let mirrorPrevStatus = null;
    try {
      const sres = await pool.query(
        "SELECT status FROM appointment WHERE appointment_id = $1 LIMIT 1",
        [updated.id],
      );
      mirrorPrevStatus =
        sres.rowCount > 0 && sres.rows[0]?.status
          ? String(sres.rows[0].status).toLowerCase()
          : null;
    } catch {}

    const shouldAccept =
      actorRole === "doctor" &&
      !updated.done &&
      (mirrorPrevStatus === "pending" || mirrorPrevStatus == null);

    // Mirror to simplified table by appointment_id
    try {
      const status = updated.done
        ? "done"
        : shouldAccept
          ? "accepted"
          : mirrorPrevStatus === "accepted"
            ? "accepted"
            : "pending";
      await pool.query(
        `INSERT INTO appointment (full_name, date, time, status, appointment_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (appointment_id)
         DO UPDATE SET
           full_name = COALESCE(EXCLUDED.full_name, appointment.full_name),
           date = COALESCE(EXCLUDED.date, appointment.date),
           time = COALESCE(EXCLUDED.time, appointment.time),
           status = EXCLUDED.status`,
        [updated.patient, updated.date, updated.time, status, updated.id],
      );
    } catch {}

    // Notify patient on accept / reschedule (best-effort)
    try {
      const patientName = String(updated.patient || "").trim();
      if (patientName) {
        let patientUserId = null;
        try {
          let pres = await pool.query(
            "SELECT id FROM users WHERE role ILIKE 'patient' AND LOWER(full_name) = LOWER($1) LIMIT 1",
            [patientName],
          );
          if (pres.rowCount === 0) {
            pres = await pool.query(
              "SELECT id FROM users WHERE role ILIKE 'patient' AND LOWER(full_name) LIKE LOWER($1) ORDER BY id ASC LIMIT 1",
              [`%${patientName}%`],
            );
          }
          patientUserId = pres.rowCount > 0 ? Number(pres.rows[0].id) : null;
        } catch {}

        const doctorName = String(
          actorName ||
            updated.created_by_name ||
            before?.created_by_name ||
            "Doctor",
        ).trim();

        if (patientUserId) {
          if (shouldAccept) {
            const title = "Appointment Accepted";
            const message = `Dr. ${doctorName} accepted your appointment request for ${newDate || ""} ${newTime || ""}.`;
            try {
              await pool.query(
                "INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)",
                [patientUserId, title, message],
              );
            } catch {}
          }
          if (isReschedule && actorRole === "doctor") {
            const title = "Appointment Rescheduled";
            const message = `Your appointment with Dr. ${doctorName} was rescheduled from ${oldDate || ""} ${oldTime || ""} to ${newDate || ""} ${newTime || ""}.`;
            try {
              await pool.query(
                "INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)",
                [patientUserId, title, message],
              );
            } catch {}
          }
        }
      }
    } catch {}
    // Log activity
    try {
      if (actorUserId)
        logActivity(
          actorUserId,
          "appointment_update",
          `Appointment updated: ${updated.patient} • ${updated.date} ${updated.time}`,
          updated,
        );
    } catch {}
    res.json(updated);
  } catch (err) {
    console.error("PUT /api/appointments/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Delete appointment
app.delete("/api/appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const del = await pool.query("DELETE FROM appointments WHERE id = $1", [
      id,
    ]);
    if (del.rowCount === 0)
      return res.status(404).json({ message: "Appointment not found" });
    // Remove mirror
    try {
      await pool.query("DELETE FROM appointment WHERE appointment_id = $1", [
        id,
      ]);
    } catch {}
    res.status(204).send();
  } catch (err) {
    console.error("DELETE /api/appointments/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Schedule Slots API
// Create schedule slot (doctor)
app.post("/api/schedule-slots", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const body = req.body || {};
    const date = body.date;
    const startTime = body.start_time ?? body.startTime ?? body.time;
    const endTime = body.end_time ?? body.endTime;
    const notes = body.notes;
    const statusRaw = body.status;
    let specialtyCandidate =
      body.specialty || body.doctor_specialty || body.doctorSpecialty;

    if (!date || !startTime || !endTime) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    let role = null;
    let fullName = null;
    try {
      const ures = await pool.query(
        "SELECT role, full_name, specialty FROM users WHERE id = $1",
        [userId],
      );
      if (ures.rowCount > 0) {
        role =
          (ures.rows[0]?.role || null) &&
          String(ures.rows[0].role).toLowerCase();
        fullName = ures.rows[0]?.full_name || null;
        if (!specialtyCandidate && ures.rows[0]?.specialty) {
          specialtyCandidate = ures.rows[0].specialty;
        }
      }
    } catch {}

    if (role !== "doctor") {
      return res.status(403).json({ message: "Only doctors can create slots" });
    }

    const doctorName =
      body.doctorName ||
      body.doctor_name ||
      body.createdByName ||
      body.created_by_name ||
      fullName ||
      null;
    const specialty =
      typeof specialtyCandidate === "string" && specialtyCandidate.trim()
        ? specialtyCandidate.trim()
        : null;

    const statusNorm = (() => {
      const s = String(statusRaw || "")
        .trim()
        .toLowerCase();
      if (!s) return "available";
      if (s === "available") return "available";
      if (s === "not available") return "not available";
      if (s === "not_available") return "not available";
      if (s === "unavailable") return "not available";
      return "available";
    })();

    const insert = await pool.query(
      "INSERT INTO schedule_slots (doctor_user_id, doctor_name, specialty, date, time, start_time, end_time, notes, status, is_booked) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE) RETURNING id, doctor_user_id, doctor_name, specialty, date, time, start_time, end_time, notes, status, is_booked, booked_appointment_id, created_at",
      [
        Number(userId),
        doctorName ? String(doctorName).trim() : null,
        specialty,
        String(date).trim(),
        String(startTime).trim(),
        String(startTime).trim(),
        String(endTime).trim(),
        notes || null,
        statusNorm,
      ],
    );

    logActivity(userId, "schedule_slot", "Schedule slot created", {
      id: insert.rows[0]?.id,
      doctor_user_id: userId,
      date,
      start_time: startTime,
      end_time: endTime,
      status: statusNorm,
    });
    res.status(201).json(insert.rows[0]);
  } catch (err) {
    console.error("POST /api/schedule-slots error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// List schedule slots
app.get("/api/schedule-slots", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    let role = null;
    try {
      const ures = await pool.query("SELECT role FROM users WHERE id = $1", [
        userId,
      ]);
      role =
        ures.rowCount > 0 && ures.rows[0]?.role
          ? String(ures.rows[0].role).toLowerCase()
          : null;
    } catch {}

    const q = req.query || {};
    const doctorUserIdQ =
      q.doctor_user_id || q.doctorUserId || q.doctor_id || q.doctorId;
    const doctorNameQ = q.doctor_name || q.doctorName || q.doctor;
    const dateQ = q.date;
    const startTimeQ = q.start_time || q.startTime || q.time;
    const availableOnlyQ = String(q.available || "").trim() === "1";

    const where = [];
    const params = [];

    if (role === "doctor") {
      where.push(`doctor_user_id = $${params.length + 1}`);
      params.push(Number(userId));
    } else {
      if (doctorUserIdQ != null && String(doctorUserIdQ).trim()) {
        where.push(`doctor_user_id = $${params.length + 1}`);
        params.push(Number(doctorUserIdQ));
      } else if (doctorNameQ != null && String(doctorNameQ).trim()) {
        where.push(
          `LOWER(COALESCE(doctor_name, '')) LIKE LOWER($${params.length + 1})`,
        );
        params.push(`%${String(doctorNameQ).trim()}%`);
      }
    }

    if (dateQ != null && String(dateQ).trim()) {
      where.push(`date = $${params.length + 1}`);
      params.push(String(dateQ).trim());
    }

    if (startTimeQ != null && String(startTimeQ).trim()) {
      where.push(`start_time = $${params.length + 1}`);
      params.push(String(startTimeQ).trim());
    }

    if (role === "patient" || availableOnlyQ) {
      where.push("is_booked = FALSE");
      where.push(
        "LOWER(COALESCE(status, 'available')) IN ('available', 'schedule')",
      );
    }

    const sql = `SELECT id, doctor_user_id, doctor_name, specialty, date, time, start_time, end_time, notes, status, is_booked, booked_appointment_id, created_at
                FROM schedule_slots
                ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                ORDER BY date ASC, time ASC, id ASC`;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/schedule-slots error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update schedule slot (doctor)
app.put("/api/schedule-slots/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const body = req.body || {};

    let role = null;
    try {
      const ures = await pool.query("SELECT role FROM users WHERE id = $1", [
        userId,
      ]);
      role =
        ures.rowCount > 0 && ures.rows[0]?.role
          ? String(ures.rows[0].role).toLowerCase()
          : null;
    } catch {}

    if (role !== "doctor") {
      return res.status(403).json({ message: "Only doctors can update slots" });
    }

    const date = body.date;
    const startTime = body.start_time ?? body.startTime ?? body.time;
    const endTime = body.end_time ?? body.endTime;
    const notes = body.notes;
    const status = body.status;

    const upd = await pool.query(
      `UPDATE schedule_slots
         SET date = COALESCE($1, date),
             time = COALESCE($2, time),
             start_time = COALESCE($3, start_time),
             end_time = COALESCE($4, end_time),
             notes = COALESCE($5, notes),
             status = COALESCE($6, status)
       WHERE id = $7 AND doctor_user_id = $8
       RETURNING id, doctor_user_id, doctor_name, specialty, date, time, start_time, end_time, notes, status, is_booked, booked_appointment_id, created_at`,
      [
        date != null ? String(date).trim() : null,
        startTime != null ? String(startTime).trim() : null,
        startTime != null ? String(startTime).trim() : null,
        endTime != null ? String(endTime).trim() : null,
        notes != null ? notes : null,
        status != null ? String(status).trim() : null,
        id,
        Number(userId),
      ],
    );
    if (upd.rowCount === 0)
      return res.status(404).json({ message: "Schedule slot not found" });
    res.json(upd.rows[0]);
  } catch (err) {
    console.error("PUT /api/schedule-slots/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Delete schedule slot (doctor)
app.delete("/api/schedule-slots/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;

    let role = null;
    try {
      const ures = await pool.query("SELECT role FROM users WHERE id = $1", [
        userId,
      ]);
      role =
        ures.rowCount > 0 && ures.rows[0]?.role
          ? String(ures.rows[0].role).toLowerCase()
          : null;
    } catch {}

    if (role !== "doctor") {
      return res.status(403).json({ message: "Only doctors can delete slots" });
    }

    const del = await pool.query(
      "DELETE FROM schedule_slots WHERE id = $1 AND doctor_user_id = $2",
      [id, Number(userId)],
    );
    if (del.rowCount === 0)
      return res.status(404).json({ message: "Schedule slot not found" });
    res.status(204).send();
  } catch (err) {
    console.error("DELETE /api/schedule-slots/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Book schedule slot (atomic)
app.post("/api/schedule-slots/:id/book", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const body = req.body || {};
    const appointmentId =
      body.appointment_id ?? body.appointmentId ?? body.booked_appointment_id;

    const upd = await pool.query(
      `UPDATE schedule_slots
         SET is_booked = TRUE,
             status = 'booked',
             booked_appointment_id = COALESCE($2, booked_appointment_id)
       WHERE id = $1 AND is_booked = FALSE
       RETURNING id, doctor_user_id, doctor_name, specialty, date, time, notes, status, is_booked, booked_appointment_id, created_at`,
      [id, appointmentId != null ? Number(appointmentId) : null],
    );

    if (upd.rowCount === 0) {
      const chk = await pool.query(
        "SELECT id, is_booked FROM schedule_slots WHERE id = $1",
        [id],
      );
      if (chk.rowCount === 0)
        return res.status(404).json({ message: "Schedule slot not found" });
      return res.status(409).json({ message: "Schedule slot already booked" });
    }

    logActivity(userId, "schedule_slot_book", "Schedule slot booked", {
      slot_id: id,
      appointment_id: appointmentId ?? null,
    });
    res.json(upd.rows[0]);
  } catch (err) {
    console.error("POST /api/schedule-slots/:id/book error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Admin Manage Users API
// List users (mobile expects fields: id, name, email, role, active)
app.get("/api/users", async (req, res) => {
  try {
    const roleQ = String(req.query?.role || "")
      .trim()
      .toLowerCase();
    let where = "";
    const params = [];
    if (roleQ) {
      // Normalize to match existing roles
      const roleNorm = roleQ === "lab staff" ? "labstaff" : roleQ;
      where = "WHERE LOWER(role) = LOWER($1)";
      params.push(roleNorm);
    }
    const result = await pool.query(
      `SELECT id, full_name AS name, role, email, active, specialty FROM users ${where} ORDER BY id DESC`,
      params,
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/users error:", err);
    res.status(500).json({ message: "Database error" });
  }
});

// Get single user by ID (for profile pages) - checks profile table first, then users table
app.get("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    // First try to get from profile table
    let result = await pool.query(
      "SELECT p.id, p.fullname AS name, p.role, p.email, p.phone, p.address, p.birthdate, p.gender, p.avatar_uri, u.specialty AS specialty FROM profile p LEFT JOIN users u ON u.id = p.id WHERE p.id = $1",
      [id],
    );
    // If not found in profile table, check users table
    if (result.rowCount === 0) {
      result = await pool.query(
        "SELECT id, full_name AS name, role, email, active, phone, address, birthdate, gender, avatar_uri, specialty FROM users WHERE id = $1",
        [id],
      );
    }
    if (result.rowCount === 0)
      return res.status(404).json({ message: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /api/users/:id error:", err);
    res.status(500).json({ message: "Database error" });
  }
});

// Get profile by ID (direct profile table access)
app.get("/api/profile/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT p.id, p.fullname AS name, p.role, p.email, p.phone, p.address, p.birthdate, p.gender, p.avatar_uri, p.created_at, p.last_edited, u.specialty AS specialty FROM profile p LEFT JOIN users u ON u.id = p.id WHERE p.id = $1",
      [id],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ message: "Profile not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /api/profile/:id error:", err);
    res.status(500).json({ message: "Database error" });
  }
});

// Update profile by ID
app.put("/api/profile/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      role,
      phone,
      address,
      birthdate,
      gender,
      avatar_uri,
      specialty,
    } = req.body || {};
    // Convert empty strings to null to avoid PostgreSQL errors
    const cleanPhone = phone && phone.trim() ? phone.trim() : null;
    const cleanAddress = address && address.trim() ? address.trim() : null;
    const cleanBirthdate =
      birthdate && birthdate.trim() ? birthdate.trim() : null;
    const cleanGender = gender && gender.trim() ? gender.trim() : null;
    const cleanName = name && name.trim() ? name.trim() : null;
    const cleanEmail = email && email.trim() ? email.trim() : null;
    const cleanRole = role && role.trim() ? role.trim() : null;
    const cleanSpecialty =
      typeof specialty === "string" && specialty.trim()
        ? specialty.trim()
        : null;

    const result = await pool.query(
      `UPDATE profile 
         SET fullname = COALESCE($1, fullname),
             email = COALESCE($2, email),
             role = COALESCE($3, role),
             phone = COALESCE($4, phone),
             address = COALESCE($5, address),
             birthdate = COALESCE($6, birthdate),
             gender = COALESCE($7, gender),
             avatar_uri = COALESCE($8, avatar_uri),
             last_edited = NOW()
         WHERE id = $9
         RETURNING id, fullname AS name, role, email, phone, address, birthdate, gender, avatar_uri, created_at, last_edited`,
      [
        cleanName,
        cleanEmail,
        cleanRole,
        cleanPhone,
        cleanAddress,
        cleanBirthdate,
        cleanGender,
        avatar_uri || null,
        id,
      ],
    );

    // Specialty is stored on users table (not profile); update best-effort
    try {
      if (cleanSpecialty !== null) {
        await pool.query(
          "UPDATE users SET specialty = COALESCE($1, specialty), updated_at = NOW() WHERE id = $2",
          [cleanSpecialty, id],
        );
      }
    } catch {}

    if (result.rowCount === 0)
      return res.status(404).json({ message: "Profile not found" });
    const row = result.rows[0];
    if (cleanSpecialty !== null) row.specialty = cleanSpecialty;
    else {
      try {
        const ures = await pool.query(
          "SELECT specialty FROM users WHERE id = $1 LIMIT 1",
          [id],
        );
        if (ures.rowCount > 0) row.specialty = ures.rows[0]?.specialty || null;
      } catch {}
    }
    res.json(row);
  } catch (err) {
    console.error("PUT /api/profile/:id error:", err);
    res.status(500).json({ message: "Server error updating profile" });
  }
});

// User registration endpoint
app.post("/api/users/register", async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { fullName, role, email, password } = req.body || {};

    // Input validation
    if (!fullName || !role || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "All fields are required: fullName, role, email, password",
      });
    }

    // Validate role
    const allowedRoles = ["doctor", "patient"];
    const normalizedRole = role.toLowerCase();
    if (!allowedRoles.includes(normalizedRole)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Must be either "doctor" or "patient"',
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address",
      });
    }

    // Check password strength
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    // Check if user already exists
    const existingUser = await client.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [email],
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "A user with this email already exists",
      });
    }

    // Hash password with bcrypt
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Insert new user with additional fields
    const result = await client.query(
      `INSERT INTO users (
          full_name, 
          email, 
          password_hash, 
          role, 
          active,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, full_name, email, role, created_at`,
      [
        fullName.trim(),
        email.toLowerCase().trim(),
        hashedPassword,
        normalizedRole,
        true,
        new Date().toISOString(),
      ],
    );

    const newUser = result.rows[0];

    // Log the registration
    await logActivity(newUser.id, "user_registered", "New user registered", {
      role: normalizedRole,
      email: email.toLowerCase(),
    });

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Registration successful",
      user: {
        id: newUser.id,
        fullName: newUser.full_name,
        email: newUser.email,
        role: newUser.role,
        createdAt: newUser.created_at,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Registration error:", error);

    // Handle specific database errors
    if (error.code === "23505") {
      // Unique violation
      return res.status(409).json({
        success: false,
        message: "A user with this email already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "An error occurred during registration",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// Update user
app.put("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      role,
      active,
      password,
      phone,
      address,
      birthdate,
      gender,
      avatar_uri,
    } = req.body || {};
    if (!name || !email || !role) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    const normalizedEmail = String(email).toLowerCase().trim();
    // If password provided, hash and update in a single query; otherwise keep existing hash
    let result;
    if (password) {
      const password_hash = await bcrypt.hash(String(password), 10);
      result = await pool.query(
        "UPDATE users SET full_name = $1, email = $2, role = $3, active = COALESCE($4, active), password_hash = $5, phone = COALESCE($6, phone), address = COALESCE($7, address), birthdate = COALESCE($8, birthdate), gender = COALESCE($9, gender), avatar_uri = COALESCE($10, avatar_uri) WHERE id = $11 RETURNING id, full_name AS name, role, email, active, phone, address, birthdate, gender, avatar_uri",
        [
          name,
          normalizedEmail,
          role,
          typeof active === "boolean" ? active : null,
          password_hash,
          phone ?? null,
          address ?? null,
          birthdate ?? null,
          gender ?? null,
          avatar_uri ?? null,
          id,
        ],
      );
    } else {
      result = await pool.query(
        "UPDATE users SET full_name = $1, email = $2, role = $3, active = COALESCE($4, active), phone = COALESCE($5, phone), address = COALESCE($6, address), birthdate = COALESCE($7, birthdate), gender = COALESCE($8, gender), avatar_uri = COALESCE($9, avatar_uri) WHERE id = $10 RETURNING id, full_name AS name, role, email, active, phone, address, birthdate, gender, avatar_uri",
        [
          name,
          normalizedEmail,
          role,
          typeof active === "boolean" ? active : null,
          phone ?? null,
          address ?? null,
          birthdate ?? null,
          gender ?? null,
          avatar_uri ?? null,
          id,
        ],
      );
    }
    if (result.rowCount === 0)
      return res.status(404).json({ message: "User not found" });

    // Also sync to profile table (UPSERT to ensure consistency)
    try {
      const cleanPhone =
        phone && String(phone).trim() ? String(phone).trim() : null;
      const cleanAddress =
        address && String(address).trim() ? String(address).trim() : null;
      const cleanBirthdate =
        birthdate && String(birthdate).trim() ? String(birthdate).trim() : null;
      const cleanGender =
        gender && String(gender).trim() ? String(gender).trim() : null;
      await pool.query(
        `INSERT INTO profile (id, fullname, email, role, phone, address, birthdate, gender, avatar_uri, last_edited)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
           ON CONFLICT (id) DO UPDATE SET
             fullname = EXCLUDED.fullname,
             email = EXCLUDED.email,
             role = EXCLUDED.role,
             phone = COALESCE(EXCLUDED.phone, profile.phone),
             address = COALESCE(EXCLUDED.address, profile.address),
             birthdate = COALESCE(EXCLUDED.birthdate, profile.birthdate),
             gender = COALESCE(EXCLUDED.gender, profile.gender),
             avatar_uri = COALESCE(EXCLUDED.avatar_uri, profile.avatar_uri),
             last_edited = NOW()`,
        [
          id,
          name,
          normalizedEmail,
          role,
          cleanPhone,
          cleanAddress,
          cleanBirthdate,
          cleanGender,
          avatar_uri ?? null,
        ],
      );
    } catch (profileErr) {
      console.warn("Profile sync error:", profileErr);
      // Don't fail the request if profile sync fails
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /api/users/:id error:", err);
    res.status(500).json({ message: err?.message || "Server error" });
  }
});

// Toggle active
app.patch("/api/users/:id/active", async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body || {};
    if (typeof active !== "boolean") {
      return res.status(400).json({ message: "'active' must be boolean" });
    }
    const result = await pool.query(
      "UPDATE users SET active = $1 WHERE id = $2 RETURNING id, full_name AS name, role, email, active",
      [active, id],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ message: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PATCH /api/users/:id/active error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Delete user
app.delete("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const del = await pool.query("DELETE FROM users WHERE id = $1", [id]);
    if (del.rowCount === 0)
      return res.status(404).json({ message: "User not found" });
    res.status(204).send();
  } catch (err) {
    console.error("DELETE /api/users/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ Register route
app.post("/api/register", async (req, res) => {
  try {
    const { fullName, role, email, password } = req.body || {};

    if (!fullName || !role || !email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [
      normalizedEmail,
    ]);
    if (existing.rowCount > 0) {
      return res
        .status(409)
        .json({ success: false, message: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const insert = await pool.query(
      "INSERT INTO users (full_name, role, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, full_name, role, email, created_at",
      [fullName, role, normalizedEmail, password_hash],
    );

    console.log("✅ User registered:", insert.rows[0]);

    res.json({ success: true, user: insert.rows[0] });
  } catch (err) {
    console.error("❌ Registration error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Login route
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res
        .status(400)
        .json({ success: false, message: "Missing email or password" });

    const normalizedEmail = email.toLowerCase().trim();

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      normalizedEmail,
    ]);
    if (result.rowCount === 0)
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });

    const user = result.rows[0];
    if (user.active === false) {
      return res.status(403).json({
        success: false,
        message: "Account is disabled. Contact an administrator.",
      });
    }
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid)
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });

    delete user.password_hash;
    res.json({ success: true, user });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Prescriptions API =====
// Create prescription
app.post("/api/prescription", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const {
      patient_name,
      doctor_name,
      medicine,
      quantity,
      dosage_strength,
      description,
    } = req.body || {};
    if (!patient_name || !doctor_name || !medicine) {
      return res.status(400).json({
        message: "Missing required fields: patient_name, doctor_name, medicine",
      });
    }
    const result = await pool.query(
      "INSERT INTO prescription (doctor_name, patient_name, medicine, quantity, dosage_strength, description, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, doctor_name, patient_name, medicine, quantity, dosage_strength, description, created_at",
      [
        String(doctor_name).trim(),
        String(patient_name).trim(),
        String(medicine).trim(),
        Number(quantity) || 0,
        dosage_strength || null,
        description || null,
        userId,
      ],
    );

    // Notify patient (best-effort)
    try {
      const patientName = String(patient_name || "").trim();
      let patientUserId = null;
      if (patientName) {
        let pres = await pool.query(
          "SELECT id FROM users WHERE role ILIKE 'patient' AND LOWER(full_name) = LOWER($1) LIMIT 1",
          [patientName],
        );
        if (pres.rowCount === 0) {
          pres = await pool.query(
            "SELECT id FROM users WHERE role ILIKE 'patient' AND LOWER(full_name) LIKE LOWER($1) ORDER BY id ASC LIMIT 1",
            [`%${patientName}%`],
          );
        }
        patientUserId = pres.rowCount > 0 ? Number(pres.rows[0].id) : null;
      }
      if (patientUserId) {
        const title = "New Prescription";
        const msg = `Dr. ${String(doctor_name).trim()} sent you a prescription • ${String(
          medicine,
        ).trim()}`;
        await pool.query(
          "INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)",
          [patientUserId, title, msg],
        );
      }
    } catch {}

    // Log activity
    logActivity(
      userId,
      "prescription",
      `Prescription submitted: ${patient_name} • ${medicine}`,
      {
        id: result.rows[0]?.id,
        patient_name,
        doctor_name,
        medicine,
        quantity,
        dosage_strength,
      },
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/prescription error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get all prescriptions for a specific user (by URL param id)
app.get("/api/prescription/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const userId = Number(id);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const result = await pool.query(
      "SELECT id, doctor_name, patient_name, medicine, quantity, dosage_strength, description, status, created_at FROM prescription WHERE created_by_user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/prescription/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update prescription
app.put("/api/prescription/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    const {
      patient_name,
      doctor_name,
      medicine,
      quantity,
      dosage_strength,
      description,
      status,
    } = req.body || {};

    let nextStatus = status ?? null;
    if (nextStatus != null) {
      const s = String(nextStatus).trim().toLowerCase();
      if (!s) {
        nextStatus = null;
      } else if (
        s === "pending" ||
        s === "completed" ||
        s === "dispensed" ||
        s === "cancelled" ||
        s === "rejected" ||
        s === "accepted"
      ) {
        nextStatus =
          s === "dispensed" ? "completed" : s === "accepted" ? "completed" : s;
      } else {
        return res.status(400).json({ message: "Invalid status" });
      }
    }
    const result = await pool.query(
      `UPDATE prescription
         SET doctor_name = COALESCE($1, doctor_name),
             patient_name = COALESCE($2, patient_name),
             medicine = COALESCE($3, medicine),
             quantity = COALESCE($4, quantity),
             dosage_strength = COALESCE($5, dosage_strength),
             description = COALESCE($6, description),
             status = COALESCE($7, status)
         WHERE id = $8
         RETURNING id, doctor_name, patient_name, medicine, quantity, dosage_strength, description, status, created_at`,
      [
        doctor_name ?? null,
        patient_name ?? null,
        medicine ?? null,
        quantity ?? null,
        dosage_strength ?? null,
        description ?? null,
        nextStatus,
        id,
      ],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ message: "Prescription not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /api/prescription/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Delete prescription
app.delete("/api/prescription/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const del = await pool.query("DELETE FROM prescription WHERE id = $1", [
      id,
    ]);
    if (del.rowCount === 0)
      return res.status(404).json({ message: "Prescription not found" });
    res.status(204).send();
  } catch (err) {
    console.error("DELETE /api/prescription/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Start the server
