// server.js
import express from "express";
import pkg from "pg";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// ✅ PostgreSQL connection
const pool = new Pool({ //new added
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "gondola.proxy.rlwy.net",
  database: process.env.DB_NAME || "railway",
  password: process.env.DB_PASSWORD || "WkzkMhBNHYDiSkYpAHbWfCMJzINdKidg",
  port: Number(process.env.DB_PORT) || 27436,
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Railway
});

// ✅ Function to ensure the users table exists
async function ensureSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name TEXT,
        role TEXT,
        email TEXT UNIQUE,
        password_hash TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Ensure 'active' column exists for admin management toggles
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;`);
    // Ensure password_hash exists for credential storage
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
    // Remove legacy unique constraint on role to allow multiple users per role
    try {
      await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_key;`);
    } catch (e) {
      console.warn('Could not drop users_role_key constraint (may not exist):', e?.message);
    }
    // Optional profile fields
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthdate TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;`);

    // Appointments table for doctor scheduling
    await pool.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        patient TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        notes TEXT,
        done BOOLEAN DEFAULT FALSE,
        created_by_name TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    // Add missing column if table already existed previously without it
    await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS created_by_name TEXT;`);

    // Compatibility table (as shown in your DB UI): store full_name, date, time, status
    await pool.query(`
      CREATE TABLE IF NOT EXISTS appointment (
        full_name TEXT,
        date TEXT,
        time TEXT,
        status TEXT,
        appointment_id INTEGER UNIQUE
      );
    `);
    // Make sure new columns exist if table was created earlier
    await pool.query(`ALTER TABLE appointment ADD COLUMN IF NOT EXISTS date TEXT;`);
    await pool.query(`ALTER TABLE appointment ADD COLUMN IF NOT EXISTS time TEXT;`);
    await pool.query(`ALTER TABLE appointment ADD COLUMN IF NOT EXISTS status TEXT;`);
    await pool.query(`ALTER TABLE appointment ADD COLUMN IF NOT EXISTS appointment_id INTEGER UNIQUE;`);

    // Pharmacy inventory table for medicines
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        category TEXT,
        brand_name TEXT,
        generic_name TEXT NOT NULL,
        dosage_type TEXT,
        strength TEXT,
        unit TEXT,
        expiration_date TEXT,
        stock INTEGER DEFAULT 0,
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    // Ensure stock column exists for earlier deployments
    await pool.query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0;`);

    // Profile table for storing user profile information
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profile (
        id SERIAL PRIMARY KEY,
        fullname TEXT,
        role TEXT,
        email TEXT,
        phone TEXT,
        address TEXT,
        gender TEXT,
        birthdate TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_edited TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    console.log("✅ Database schema ensured");
  } catch (err) {
    console.error("❌ Schema error:", err);
  }
}

// ✅ Initialize server after ensuring schema
(async () => {
  await ensureSchema();

  // 🟩 Routes
  app.get("/users", async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT id, full_name, role, email, active, created_at FROM users ORDER BY id DESC"
      );
      res.json(result.rows);
    } catch (err) {
      console.error("GET /users error:", err);
      res.status(500).json({ error: "Database error" });
    }
  });

  // Update inventory details (name/category/stock)
  app.put('/api/inventory/:id', async (req, res) => {
    try {
      const { id } = req.params;
      // Accept either split fields or a combined name ("Generic (Brand)")
      let { genericName, brandName, category, stock } = req.body || {};
      if (!genericName && typeof req.body?.name === 'string') {
        const name = String(req.body.name);
        const m = name.match(/^\s*(.*?)\s*(?:\((.*?)\))?\s*$/);
        genericName = m ? (m[1] || '').trim() : name.trim();
        brandName = m ? (m[2] || '').trim() || null : null;
      }
      const result = await pool.query(
        `UPDATE inventory
         SET generic_name = COALESCE($1, generic_name),
             brand_name = COALESCE($2, brand_name),
             category = COALESCE($3, category),
             stock = COALESCE($4, stock)
         WHERE id = $5
         RETURNING id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at`,
        [genericName ?? null, brandName ?? null, category ?? null, (Number.isFinite(Number(stock)) ? Number(stock) : null), id]
      );
      if (result.rowCount === 0) return res.status(404).json({ message: 'Inventory item not found' });
      res.json(result.rows[0]);
    } catch (err) {
      console.error('PUT /api/inventory/:id error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // Patch stock only
  app.patch('/api/inventory/:id/stock', async (req, res) => {
    try {
      const { id } = req.params;
      const { stock, delta } = req.body || {};
      if (typeof stock !== 'number' && typeof delta !== 'number') {
        return res.status(400).json({ message: 'Provide stock or delta as a number' });
      }
      let result;
      if (typeof delta === 'number') {
        result = await pool.query(
          `UPDATE inventory SET stock = GREATEST(0, stock + $1) WHERE id = $2
           RETURNING id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at`,
          [delta, id]
        );
      } else {
        result = await pool.query(
          `UPDATE inventory SET stock = GREATEST(0, $1) WHERE id = $2
           RETURNING id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at`,
          [Number(stock), id]
        );
      }
      if (result.rowCount === 0) return res.status(404).json({ message: 'Inventory item not found' });
      res.json(result.rows[0]);
    } catch (err) {
      console.error('PATCH /api/inventory/:id/stock error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // ===== Pharmacy Inventory API =====
  app.post('/api/inventory', async (req, res) => {
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
      if (!genericName) return res.status(400).json({ message: 'Missing genericName' });
      const result = await pool.query(
        `INSERT INTO inventory (category, brand_name, generic_name, dosage_type, strength, unit, expiration_date, stock, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at`,
        [category || null, brandName || null, String(genericName).trim(), dosageType || null, strength || null, unit || null, expirationDate || null, Number.isFinite(Number(stock)) ? Number(stock) : 0, description || null]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('POST /api/inventory error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  app.get('/api/inventory', async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, category, brand_name AS "brandName", generic_name AS "genericName", dosage_type AS "dosageType", strength, unit, expiration_date AS "expirationDate", stock, description, created_at FROM inventory ORDER BY created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('GET /api/inventory error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // Return all patient records (with timestamps and fields) for reporting
  app.get('/api/patient-records/all', async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, patient, date, time, notes, doctor, medicine, dosage, created_at
         FROM patient_records
         ORDER BY created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('GET /api/patient-records/all error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // Merge into latest record for a patient (avoid duplicates)
  app.put('/api/patient-records/latest', async (req, res) => {
    try {
      const { patient, doctor, medicine, dosage, notes, date, time } = req.body || {};
      if (!patient) return res.status(400).json({ message: 'Missing patient' });
      // Try update latest row for this patient
      const update = await pool.query(
        `WITH latest AS (
           SELECT id FROM patient_records WHERE patient = $1 ORDER BY created_at DESC LIMIT 1
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
        [String(patient).trim(), doctor ?? null, medicine ?? null, dosage ?? null, notes ?? null, date ?? null, time ?? null]
      );
      if (update.rowCount > 0) return res.json(update.rows[0]);
      // If no existing, insert new
      const insert = await pool.query(
        'INSERT INTO patient_records (patient, date, time, notes, doctor, medicine, dosage) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, patient, date, time, notes, doctor, medicine, dosage, created_at',
        [String(patient).trim(), date ?? null, time ?? null, notes ?? null, doctor ?? null, medicine ?? null, dosage ?? null]
      );
      res.json(insert.rows[0]);
    } catch (err) {
      console.error('PUT /api/patient-records/latest error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // ===== Patient Records API (for Doctor Patient Records screen) =====
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
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    // Ensure new columns exist for existing deployments
    await pool.query(`ALTER TABLE patient_records ADD COLUMN IF NOT EXISTS doctor TEXT;`);
    await pool.query(`ALTER TABLE patient_records ADD COLUMN IF NOT EXISTS medicine TEXT;`);
    await pool.query(`ALTER TABLE patient_records ADD COLUMN IF NOT EXISTS dosage TEXT;`);
  } catch (e) {
    console.error('ensure patient_records table error:', e);
  }

  // Add a patient record entry
  app.post('/api/patient-records', async (req, res) => {
    try {
      const { patient, date, time, notes, doctor, medicine, dosage } = req.body || {};
      if (!patient) return res.status(400).json({ message: 'Missing patient' });
      const insert = await pool.query(
        'INSERT INTO patient_records (patient, date, time, notes, doctor, medicine, dosage) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, patient, date, time, notes, doctor, medicine, dosage, created_at',
        [String(patient).trim(), date || null, time || null, notes || null, doctor ? String(doctor).trim() : null, medicine ? String(medicine).trim() : null, dosage ? String(dosage).trim() : null]
      );
      res.status(201).json(insert.rows[0]);
    } catch (err) {
      console.error('POST /api/patient-records error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // List distinct patients with latest record timestamp
  app.get('/api/patient-records', async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT patient, MAX(created_at) AS last_ts FROM patient_records GROUP BY patient ORDER BY last_ts DESC`
      );
      res.json(result.rows.map(r => ({ patient: r.patient, last_ts: r.last_ts })));
    } catch (err) {
      console.error('GET /api/patient-records error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // ===== Doctor Appointments API =====
  // Create appointment
  app.post('/api/appointments', async (req, res) => {
    try {
      const { patient, date, time, notes, done = false, createdByName } = req.body || {};
      if (!patient || !date || !time) {
        return res.status(400).json({ message: 'Missing required fields' });
      }
      const insert = await pool.query(
        'INSERT INTO appointments (patient, date, time, notes, done, created_by_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, patient, date, time, notes, done, created_by_name, created_at',
        [String(patient).trim(), String(date).trim(), String(time).trim(), notes || null, Boolean(done), createdByName ? String(createdByName).trim() : null]
      );
      // Also reflect into simplified table for UI: store patient full name, date, time, and status
      try {
        const status = Boolean(done) ? 'done' : 'pending';
        await pool.query('INSERT INTO appointment (full_name, date, time, status, appointment_id) VALUES ($1, $2, $3, $4, $5)', [String(patient).trim(), String(date).trim(), String(time).trim(), status, insert.rows[0].id]);
      } catch {}
      res.status(201).json(insert.rows[0]);
    } catch (err) {
      console.error('POST /api/appointments error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // List appointments (optional)
  app.get('/api/appointments', async (_req, res) => {
    try {
      const result = await pool.query('SELECT id, patient, date, time, notes, done, created_by_name, created_at FROM appointments ORDER BY id DESC');
      res.json(result.rows);
    } catch (err) {
      console.error('GET /api/appointments error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // Update appointment
  app.put('/api/appointments/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { patient, date, time, notes, done, createdByName } = req.body || {};
      const result = await pool.query(
        'UPDATE appointments SET patient = COALESCE($1, patient), date = COALESCE($2, date), time = COALESCE($3, time), notes = COALESCE($4, notes), done = COALESCE($5, done), created_by_name = COALESCE($6, created_by_name) WHERE id = $7 RETURNING id, patient, date, time, notes, done, created_by_name, created_at',
        [patient ?? null, date ?? null, time ?? null, notes ?? null, typeof done === 'boolean' ? done : null, createdByName ?? null, id]
      );
      if (result.rowCount === 0) return res.status(404).json({ message: 'Appointment not found' });
      const updated = result.rows[0];
      // Mirror to simplified table by appointment_id
      try {
        const status = updated.done ? 'done' : 'pending';
        await pool.query(
          'UPDATE appointment SET full_name = COALESCE($1, full_name), date = COALESCE($2, date), time = COALESCE($3, time), status = $4 WHERE appointment_id = $5',
          [updated.patient, updated.date, updated.time, status, updated.id]
        );
      } catch {}
      res.json(updated);
    } catch (err) {
      console.error('PUT /api/appointments/:id error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // Delete appointment
  app.delete('/api/appointments/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const del = await pool.query('DELETE FROM appointments WHERE id = $1', [id]);
      if (del.rowCount === 0) return res.status(404).json({ message: 'Appointment not found' });
      // Remove mirror
      try { await pool.query('DELETE FROM appointment WHERE appointment_id = $1', [id]); } catch {}
      res.status(204).send();
    } catch (err) {
      console.error('DELETE /api/appointments/:id error:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });

  // ===== Admin Manage Users API =====
  // List users (mobile expects fields: id, name, email, role, active)
  app.get("/api/users", async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT id, full_name AS name, role, email, active FROM users ORDER BY id DESC"
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
        "SELECT id, fullname AS name, role, email, phone, address, birthdate, gender FROM profile WHERE id = $1",
        [id]
      );
      // If not found in profile table, check users table
      if (result.rowCount === 0) {
        result = await pool.query(
          "SELECT id, full_name AS name, role, email, active, phone, address, birthdate, gender FROM users WHERE id = $1",
          [id]
        );
      }
      if (result.rowCount === 0) return res.status(404).json({ message: "User not found" });
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
        "SELECT id, fullname AS name, role, email, phone, address, birthdate, gender, created_at, last_edited FROM profile WHERE id = $1",
        [id]
      );
      if (result.rowCount === 0) return res.status(404).json({ message: "Profile not found" });
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
      const { name, email, role, phone, address, birthdate, gender } = req.body || {};
      // Convert empty strings to null to avoid PostgreSQL errors
      const cleanPhone = phone && phone.trim() ? phone.trim() : null;
      const cleanAddress = address && address.trim() ? address.trim() : null;
      const cleanBirthdate = birthdate && birthdate.trim() ? birthdate.trim() : null;
      const cleanGender = gender && gender.trim() ? gender.trim() : null;
      const cleanName = name && name.trim() ? name.trim() : null;
      const cleanEmail = email && email.trim() ? email.trim() : null;
      const cleanRole = role && role.trim() ? role.trim() : null;
      
      const result = await pool.query(
        `UPDATE profile 
         SET fullname = COALESCE($1, fullname),
             email = COALESCE($2, email),
             role = COALESCE($3, role),
             phone = COALESCE($4, phone),
             address = COALESCE($5, address),
             birthdate = COALESCE($6, birthdate),
             gender = COALESCE($7, gender),
             last_edited = NOW()
         WHERE id = $8
         RETURNING id, fullname AS name, role, email, phone, address, birthdate, gender, created_at, last_edited`,
        [cleanName, cleanEmail, cleanRole, cleanPhone, cleanAddress, cleanBirthdate, cleanGender, id]
      );
      if (result.rowCount === 0) return res.status(404).json({ message: "Profile not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("PUT /api/profile/:id error:", err);
      res.status(500).json({ message: "Database error" });
    }
  });

  // Create user
  app.post("/api/users", async (req, res) => {
    try {
      const { name, email, role, active = true, password } = req.body || {};
      if (!name || !email || !role || !password) {
        return res.status(400).json({ message: "Missing required fields" });
      }
      const normalizedEmail = String(email).toLowerCase().trim();
      const existing = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
      if (existing.rowCount > 0) {
        return res.status(409).json({ message: "Email already exists" });
      }
      const password_hash = await bcrypt.hash(String(password), 10);
      const insert = await pool.query(
        "INSERT INTO users (full_name, role, email, active, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id, full_name AS name, role, email, active",
        [name, role, normalizedEmail, Boolean(active), password_hash]
      );
      res.status(201).json(insert.rows[0]);
    } catch (err) {
      console.error("POST /api/users error:", err);
      res.status(500).json({ message: err?.message || "Server error" });
    }
  });

  // Update user
  app.put("/api/users/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { name, email, role, active, password, phone, address, birthdate, gender } = req.body || {};
      if (!name || !email || !role) {
        return res.status(400).json({ message: "Missing required fields" });
      }
      const normalizedEmail = String(email).toLowerCase().trim();
      // If password provided, hash and update in a single query; otherwise keep existing hash
      let result;
      if (password) {
        const password_hash = await bcrypt.hash(String(password), 10);
        result = await pool.query(
          "UPDATE users SET full_name = $1, email = $2, role = $3, active = COALESCE($4, active), password_hash = $5, phone = COALESCE($6, phone), address = COALESCE($7, address), birthdate = COALESCE($8, birthdate), gender = COALESCE($9, gender) WHERE id = $10 RETURNING id, full_name AS name, role, email, active, phone, address, birthdate, gender",
          [name, normalizedEmail, role, typeof active === 'boolean' ? active : null, password_hash, phone ?? null, address ?? null, birthdate ?? null, gender ?? null, id]
        );
      } else {
        result = await pool.query(
          "UPDATE users SET full_name = $1, email = $2, role = $3, active = COALESCE($4, active), phone = COALESCE($5, phone), address = COALESCE($6, address), birthdate = COALESCE($7, birthdate), gender = COALESCE($8, gender) WHERE id = $9 RETURNING id, full_name AS name, role, email, active, phone, address, birthdate, gender",
          [name, normalizedEmail, role, typeof active === 'boolean' ? active : null, phone ?? null, address ?? null, birthdate ?? null, gender ?? null, id]
        );
      }
      if (result.rowCount === 0) return res.status(404).json({ message: "User not found" });
      
      // Also sync to profile table
      try {
        const profileExists = await pool.query("SELECT id FROM profile WHERE id = $1", [id]);
        // Convert empty strings to null to avoid PostgreSQL errors
        const cleanPhone = phone && phone.trim() ? phone.trim() : null;
        const cleanAddress = address && address.trim() ? address.trim() : null;
        const cleanBirthdate = birthdate && birthdate.trim() ? birthdate.trim() : null;
        const cleanGender = gender && gender.trim() ? gender.trim() : null;
        
        if (profileExists.rowCount > 0) {
          // Update existing profile
          await pool.query(
            "UPDATE profile SET fullname = $1, email = $2, role = $3, phone = COALESCE($4, phone), address = COALESCE($5, address), birthdate = COALESCE($6, birthdate), gender = COALESCE($7, gender), last_edited = NOW() WHERE id = $8",
            [name, normalizedEmail, role, cleanPhone, cleanAddress, cleanBirthdate, cleanGender, id]
          );
        } else {
          // Insert new profile
          await pool.query(
            "INSERT INTO profile (id, fullname, email, role, phone, address, birthdate, gender) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            [id, name, normalizedEmail, role, cleanPhone, cleanAddress, cleanBirthdate, cleanGender]
          );
        }
      } catch (profileErr) {
        console.warn('Profile sync error:', profileErr);
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
        [active, id]
      );
      if (result.rowCount === 0) return res.status(404).json({ message: "User not found" });
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
      if (del.rowCount === 0) return res.status(404).json({ message: "User not found" });
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
        [fullName, role, normalizedEmail, password_hash]
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
        return res
          .status(403)
          .json({ success: false, message: "Account is disabled. Contact an administrator." });
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

  // ✅ Start server only after DB check
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
})();
