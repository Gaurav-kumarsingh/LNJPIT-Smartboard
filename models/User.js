/**
 * SMARTBOARD — models/User.js
 * MongoDB Atlas schema for student/teacher user accounts.
 *
 * ONLY authentication data (username + hashed password) is stored here.
 * Files (PDF, images, video) continue to live on disk — MongoDB is NOT
 * used for file storage (no GridFS, no base64 blobs).
 */
'use strict';

const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const BCRYPT_ROUNDS = 10;

// ── Schema ─────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema(
  {
    username: {
      type:      String,
      required:  [true, 'Username is required'],
      unique:    true,
      trim:      true,
      minlength: [3,  'Username must be at least 3 characters'],
      maxlength: [50, 'Username must be 50 characters or fewer'],
      // Only allow safe characters (letters, digits, _ -)
      match: [/^[a-zA-Z0-9_-]+$/, 'Username may only contain letters, digits, _ or -'],
    },
    // email is optional but unique when provided
    email: {
      type:      String,
      unique:    true,
      sparse:    true,   // allows multiple docs with no email (null != null in Mongo)
      trim:      true,
      lowercase: true,
      match:     [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address'],
    },
    password: {
      type:     String,
      required: [true, 'Password is required'],
      // Never send the hash to the client
      select:   false,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: false },
    // When JSON-ified, replace _id with id and strip __v
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id.toHexString();
        delete ret._id;
        delete ret.__v;
        delete ret.password; // extra safety — should already be excluded by select:false
        return ret;
      },
    },
  }
);

// ── Pre-save hook — hash password whenever it is modified ──────────────────
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
});

// ── Instance method — safe password comparison ─────────────────────────────
userSchema.methods.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.password);
};

// ── Static helper — find by username OR email (for login) ─────────────────
userSchema.statics.findByLogin = function (identifier) {
  const trimmed = identifier.trim();
  // Escape any regex special chars in the identifier to prevent ReDoS
  const safe  = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lower = trimmed.toLowerCase();
  return this.findOne({
    $or: [
      { username: new RegExp(`^${safe}$`, 'i') },
      { email: lower },
    ],
  }).select('+password'); // override select:false so we can compare the hash
};

module.exports = mongoose.model('User', userSchema);
